// Command line: `ac-playtest serve <buildDir>` serves a build with the simulated platform for manual playtests.
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startServer, SIM_PATH } from './server.js';

const HELP = `ac-playtest: offline playtests for AirConsole games (unofficial)

Usage:
  ac-playtest serve <buildDir> [options]

  <buildDir> must contain screen.html and controller.html (or --path must point to a folder below it that does).

Options:
  --path <dir>          the game's folder inside <buildDir>, e.g. example-premium/, for games that load shared
                        files from parent folders (../styles/...); <buildDir> is then the web root
  --port <n>            port to listen on (default 8080, 0 = any free port)
  --host <addr>         interface to bind (default 127.0.0.1)
  --phones <n>          phones that join when the page opens (default 2)
  --scale <f>           display scale of the screen and phone frames (default 0.5)
  --api-version <v>     version the stand-in API reports (default: the version in the game's script tag)
  --official-api        load the official AirConsole API from airconsole.com instead of the
                        offline stand-in (needs internet; checks the simulator against the real client)
  --open                open the sim page in the default browser
  -h, --help            show this help
  -v, --version         show the version

Scripted playtests: import { launch } from 'ac-playtest' (see README).`;

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '8080' },
      path: { type: 'string', default: '' },
      host: { type: 'string', default: '127.0.0.1' },
      phones: { type: 'string', default: '2' },
      scale: { type: 'string', default: '0.5' },
      'api-version': { type: 'string' },
      'official-api': { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }
  const [command, buildDir, ...extra] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  if (command !== 'serve') throw new Error(`unknown command "${command}" (try --help)`);
  if (!buildDir) throw new Error('serve needs a build folder: ac-playtest serve <buildDir>');
  if (extra.length) throw new Error(`unexpected arguments: ${extra.join(' ')}`);

  const port = integer('--port', values.port, 0, 65535);
  const phones = integer('--phones', values.phones, 0, 64);
  const scale = Number(values.scale);
  if (!(scale > 0 && scale <= 4)) throw new Error('--scale must be a number between 0 and 4');

  const server = await startServer({
    build: buildDir, path: values.path, port, host: values.host, apiVersion: values['api-version'],
    api: values['official-api'] ? 'official' : 'builtin',
    log: (line) => console.log(`  ${line}`),
  });
  const shownHost = values.host === '127.0.0.1' || values.host === '::1' ? 'localhost' : values.host;
  const query = new URLSearchParams({ phones: String(phones), scale: String(scale) });
  if (server.gamePath) query.set('path', server.gamePath);
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${server.port}${SIM_PATH}?${query}`;
  console.log(`ac-playtest serving ${server.root}${server.gamePath ? ` (game in ${server.gamePath})` : ''}`);
  console.log(`  sim:  ${url}`);
  console.log(`  API:  ${values['official-api'] ? 'official (www.airconsole.com)' : 'offline stand-in'}`);
  console.log('  Ctrl+C to stop');
  if (values.open) openInBrowser(url);

  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();
  return 0;
}

function integer(name, raw, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function openInBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`  (could not open a browser; open the URL above yourself)`));
  child.unref();
}
