// The static server and the CLI, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { startServer, checkBuildDir, rewriteApiTags, normalizeGamePath } from '../src/index.js';
import { ROOT, DUMMY } from './support/helpers.js';

function tempBuild(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-playtest-build-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// fetch() would normalise "/../x" away and decode encodings itself; use a raw request.
function raw(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('checkBuildDir explains what an AirConsole build folder needs', () => {
  assert.throws(() => checkBuildDir(path.join(ROOT, 'nope')), /Build folder not found/);
  assert.throws(() => checkBuildDir(path.join(ROOT, 'src')), /missing screen\.html and controller\.html/);
  assert.equal(checkBuildDir(DUMMY), DUMMY);
});

test('rewriteApiTags swaps every AirConsole API script tag for the local stand-in', () => {
  const html = [
    '<script src="https://www.airconsole.com/api/airconsole-1.11.0.js"></script>',
    "<script type='text/javascript' src='http://airconsole.com/api/airconsole-1.10.0.js' async></script>",
    '<script src="//www.airconsole.com/api/airconsole-latest.js" ></script>',
    '<script src="https://example.com/api/airconsole-1.11.0.js"></script>',
  ].join('\n');
  const { html: out, versions } = rewriteApiTags(html);
  assert.deepEqual(versions, ['1.11.0', '1.10.0', 'latest']);
  assert.equal(out.split('\n')[0], '<script src="/__ac/api/airconsole-1.11.0.js"></script>');
  assert.equal(out.split('\n')[1], "<script type='text/javascript' src=\"/__ac/api/airconsole-1.10.0.js\" async></script>");
  assert.equal(out.split('\n')[2], '<script src="/__ac/api/airconsole-latest.js" ></script>');
  assert.ok(out.split('\n')[3].includes('example.com'), 'other hosts are left alone');
  assert.equal(rewriteApiTags(html, '1.9.0').html.match(/airconsole-1\.9\.0/g).length, 3);
});

test('server: encodings, MIME types, no-store, HTML rewrite, sim routes, traversal guard', async (t) => {
  const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const build = tempBuild({
    'screen.html': '<script src="https://www.airconsole.com/api/airconsole-1.11.0.js"></script>',
    'controller.html': '<p>controller</p>',
    'Build/game.wasm.br': zlib.brotliCompressSync(wasm),
    'Build/game.framework.js.gz': zlib.gzipSync('var x = 1;'),
    'Build/game.data': Buffer.alloc(16),
  });
  const server = await startServer({ build, port: 0 });
  t.after(async () => { await server.close(); fs.rmSync(build, { recursive: true, force: true }); });
  const { port } = server;

  const br = await raw(port, '/Build/game.wasm.br');
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers['content-type'], 'application/wasm');
  assert.equal(br.headers['cache-control'], 'no-store');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), wasm);

  const gz = await raw(port, '/Build/game.framework.js.gz');
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.match(gz.headers['content-type'], /^text\/javascript/);
  assert.equal((await raw(port, '/Build/game.data')).headers['content-type'], 'application/octet-stream');

  const screen = await raw(port, '/screen.html');
  assert.equal(screen.body.toString(), '<script src="/__ac/api/airconsole-1.11.0.js"></script>');
  assert.deepEqual(server.apiVersions(), ['1.11.0']);

  const api = await raw(port, '/__ac/api/airconsole-1.11.0.js');
  assert.equal(api.status, 200);
  assert.match(api.body.toString(), /window\.AirConsole = AirConsole/);
  assert.equal((await raw(port, '/__ac/sim.html')).status, 200);
  assert.match((await raw(port, '/__ac/profile-picture?uid=abc&size=32')).body.toString(), /^<svg [^>]*width="32"/);

  const root = await raw(port, '/?phones=3');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/__ac/sim.html?phones=3');

  // "/../x" is normalised by the URL parser (stays inside the build); an encoded slash must not escape it.
  assert.equal((await raw(port, '/../screen.html')).status, 200);
  assert.equal((await raw(port, '/..%2f..%2fpackage.json')).status, 403);
  assert.equal((await raw(port, '/missing.js')).status, 404);
  assert.equal((await raw(port, '/favicon.ico')).status, 204);
  const head = await raw(port, '/Build/game.data', 'HEAD');
  assert.equal(head.headers['content-length'], '16');
  assert.equal(head.body.length, 0);
});

test('server: a game in a subfolder (path option) can load shared files from the parent folder', async (t) => {
  const root = tempBuild({
    'shared/style.css': 'body { color: red; }',
    'games/one/screen.html': '<link rel="stylesheet" href="../../shared/style.css">' +
      '<script src="https://www.airconsole.com/api/airconsole-1.11.0.js"></script>',
    'games/one/controller.html': '<p>controller</p>',
    'secret.txt': 'outside',
  });
  const server = await startServer({ build: root, path: './games//one', port: 0 });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(server.gamePath, 'games/one/');
  assert.equal(server.simUrl, `${server.origin}/__ac/sim.html?path=games%2Fone%2F`);
  const screen = await raw(server.port, '/games/one/screen.html');
  assert.match(screen.body.toString(), /src="\/__ac\/api\/airconsole-1\.11\.0\.js"/);
  assert.equal((await raw(server.port, '/shared/style.css')).status, 200);
  assert.equal((await raw(server.port, '/games/one/..%2f..%2f..%2fpackage.json')).status, 403);

  assert.equal(normalizeGamePath(''), '');
  assert.equal(normalizeGamePath('/a\\b/'), 'a/b/');
  assert.throws(() => normalizeGamePath('a/../../x'), /inside the served root/);
  await assert.rejects(startServer({ build: root, path: 'games', port: 0 }), /missing screen\.html and controller\.html/);
  await assert.rejects(startServer({ build: root, path: '../', port: 0 }), /inside the served root/);
});

test('server: a busy port gives a helpful error', async (t) => {
  const first = await startServer({ build: DUMMY, port: 0 });
  t.after(() => first.close());
  await assert.rejects(startServer({ build: DUMMY, port: first.port }), /already in use/);
});

function cli(args) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/ac-playtest.js'), ...args], { cwd: ROOT });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, output: () => out, exited };
}

test('cli: serve prints the sim URL and serves the build until stopped', async () => {
  const run = cli(['serve', 'examples/dummy-game', '--port', '0', '--phones', '3']);
  const deadline = Date.now() + 10000;
  let match;
  while (!(match = /sim: {2}(http:\/\/\S+)/.exec(run.output())) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(match, run.output());
  const url = new URL(match[1]);
  assert.equal(url.pathname, '/__ac/sim.html');
  assert.equal(url.searchParams.get('phones'), '3');
  const res = await raw(Number(url.port), '/controller.html');
  assert.equal(res.status, 200);
  assert.match(res.body.toString(), /\/__ac\/api\/airconsole-1\.11\.0\.js/);
  run.child.kill('SIGTERM');
  assert.equal(await run.exited, 0);
});

test('cli: serve --path puts the game folder in the sim URL', async () => {
  const run = cli(['serve', 'examples', '--path', 'dummy-game', '--port', '0']);
  const deadline = Date.now() + 10000;
  let match;
  while (!(match = /sim: {2}(http:\/\/\S+)/.exec(run.output())) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(match, run.output());
  const url = new URL(match[1]);
  assert.equal(url.searchParams.get('path'), 'dummy-game/');
  assert.equal((await raw(Number(url.port), '/dummy-game/controller.html')).status, 200);
  run.child.kill('SIGTERM');
  assert.equal(await run.exited, 0);
});

test('cli: help, version and argument errors', async () => {
  const help = cli(['--help']);
  assert.equal(await help.exited, 0);
  assert.match(help.output(), /ac-playtest serve <buildDir>/);
  const version = cli(['--version']);
  assert.equal(await version.exited, 0);
  assert.equal(version.output().trim(), JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version);
  const missing = cli(['serve', 'does-not-exist']);
  assert.equal(await missing.exited, 1);
  assert.match(missing.output(), /Build folder not found/);
  const badPort = cli(['serve', 'examples/dummy-game', '--port', 'x']);
  assert.equal(await badPort.exited, 1);
  assert.match(badPort.output(), /--port must be an integer/);
});
