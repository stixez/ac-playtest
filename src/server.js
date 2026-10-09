// Static server for an AirConsole build plus the simulated platform.
//
//  - Everything is served from ONE origin (build, sim page, fake API), so all frames are same-origin and a test
//    driver can reach into any of them.
//  - Pre-compressed files: `x.js.br` is sent as `Content-Encoding: br` with the MIME type of `x.js` (likewise
//    `.gz`). Unity WebGL builds made without "decompression fallback" need exactly this; there is no fallback.
//  - The AirConsole API <script> tag in served HTML is rewritten to the local stand-in (/__ac/api/...).
//  - Cache-Control: no-store, so a rebuilt game is always reloaded.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sim');
export const SIM_PATH = '/__ac/sim.html';
export const IMPLEMENTED_API_VERSION = '1.11.0';

// <script src="https://www.airconsole.com/api/airconsole-1.11.0.js"></script> (any quotes, http(s) or //)
const API_TAG = /<script\b([^>]*?)\ssrc\s*=\s*(["'])(?:https?:)?\/\/(?:www\.)?airconsole\.com\/api\/airconsole-([\w.-]+?)\.js\2([^>]*)>\s*<\/script>/gi;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.unityweb': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
const ENCODINGS = { '.br': 'br', '.gz': 'gzip' };

/** Throws a readable error unless `dir` looks like an AirConsole build (screen.html + controller.html). */
export function checkBuildDir(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Build folder not found: ${root}`);
  }
  const missing = ['screen.html', 'controller.html'].filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length) {
    throw new Error(`${root} is not an AirConsole build: missing ${missing.join(' and ')}. ` +
      'AirConsole games have a screen.html (TV) and a controller.html (phones) next to each other.');
  }
  return root;
}

/** Replaces AirConsole API script tags; returns the new HTML and the versions that were found. */
export function rewriteApiTags(html, apiVersion) {
  const versions = [];
  const out = html.replace(API_TAG, (_m, before, _q, version, after) => {
    versions.push(version);
    return `<script${before} src="/__ac/api/airconsole-${apiVersion || version}.js"${after}></script>`;
  });
  return { html: out, versions };
}

/**
 * Starts the server. Resolves once it listens.
 * @param {object} opts
 * @param {string} opts.build             build folder (screen.html + controller.html)
 * @param {number} [opts.port=8080]       0 picks a free port
 * @param {string} [opts.host='127.0.0.1']
 * @param {string} [opts.apiVersion]      version the stand-in reports (default: the one in the game's script tag)
 * @param {'builtin'|'official'} [opts.api='builtin']  'official' fetches the real library from airconsole.com
 * @param {(line: string) => void} [opts.log]
 */
export async function startServer({ build, port = 8080, host = '127.0.0.1', apiVersion, api = 'builtin', log = () => {} } = {}) {
  const root = checkBuildDir(build);
  const officialCache = new Map();
  const seenVersions = new Set();

  async function officialApi(version) {
    if (!officialCache.has(version)) {
      const url = `https://www.airconsole.com/api/airconsole-${version}.js`;
      officialCache.set(version, fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      }));
      officialCache.get(version).catch(() => officialCache.delete(version));
    }
    return officialCache.get(version);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return reply(res, 400, 'bad url');
    }
    if (pathname === '/') {
      res.writeHead(302, { Location: SIM_PATH + url.search });
      return res.end();
    }
    if (pathname.startsWith('/__ac/')) return serveSim(pathname.slice(6), url, res);

    const file = path.resolve(root, '.' + pathname);
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return reply(res, 403, 'forbidden');
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      if (pathname === '/favicon.ico') return reply(res, 204, '');
      log(`404 ${pathname}`);
      return reply(res, 404, 'not found');
    }
    if (!stat.isFile()) return reply(res, 404, 'not found');

    let ext = path.extname(file).toLowerCase();
    const headers = { 'Cache-Control': 'no-store' };
    if (ENCODINGS[ext]) {
      headers['Content-Encoding'] = ENCODINGS[ext];
      ext = path.extname(file.slice(0, -ext.length)).toLowerCase();
    }
    headers['Content-Type'] = TYPES[ext] || 'application/octet-stream';

    if (ext === '.html' && !headers['Content-Encoding']) {
      const { html, versions } = rewriteApiTags(await fsp.readFile(file, 'utf8'), apiVersion);
      for (const v of versions) {
        if (!seenVersions.has(v)) {
          seenVersions.add(v);
          if (!v.startsWith('1.11.') && !apiVersion) {
            log(`note: ${pathname} loads AirConsole API ${v}; ac-playtest implements ${IMPLEMENTED_API_VERSION}`);
          }
        }
      }
      return reply(res, 200, html, headers, req.method === 'HEAD');
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  async function serveSim(name, url, res) {
    const headers = { 'Cache-Control': 'no-store' };
    const apiFile = /^api\/airconsole-([\w.-]+)\.js$/.exec(name);
    if (apiFile) {
      headers['Content-Type'] = TYPES['.js'];
      if (api === 'official') {
        try {
          return reply(res, 200, await officialApi(apiFile[1]), headers);
        } catch (e) {
          log(`could not fetch the official AirConsole API: ${e.message}`);
          return reply(res, 502, `// ac-playtest: could not fetch the official API: ${e.message}`, headers);
        }
      }
      return reply(res, 200, await fsp.readFile(path.join(SIM_DIR, 'airconsole-api.js')), headers);
    }
    if (name === 'sim.html' || name === 'platform.js') {
      headers['Content-Type'] = TYPES[path.extname(name)];
      return reply(res, 200, await fsp.readFile(path.join(SIM_DIR, name)), headers);
    }
    if (name === 'profile-picture') {
      headers['Content-Type'] = TYPES['.svg'];
      return reply(res, 200, avatar(url.searchParams.get('uid') || '', Number(url.searchParams.get('size')) || 64), headers);
    }
    return reply(res, 404, 'not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`500 ${req.url}: ${e.message}`);
      if (!res.headersSent) reply(res, 500, 'server error');
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use; pick another with --port (or 0 for any free port).`) : e));
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`;
  return {
    root,
    port: actualPort,
    origin,
    simUrl: origin + SIM_PATH,
    /** API versions found in the game's script tags so far. */
    apiVersions: () => [...seenVersions],
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function reply(res, status, body, headers = {}, headOnly = false) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers, 'Content-Length': buf.length });
  res.end(headOnly ? undefined : buf);
}

// A small deterministic avatar, so getProfilePicture() works offline.
function avatar(uid, size) {
  let hash = 0;
  for (const ch of uid) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const letter = (uid.replace(/^uid-\d+-/, '')[0] || '?').toUpperCase().replace(/[^A-Z0-9?]/, '?');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="hsl(${hue} 55% 45%)"/>` +
    `<text x="32" y="42" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
}
