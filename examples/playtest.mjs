// A scripted playtest of examples/dummy-game: phones join, tap and drag through the real controller UI, one drops
// and reconnects, the platform pauses, and the run fails on any console error.
//   node examples/playtest.mjs [--headed]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'ac-playtest';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'playtest-out');
const log = (line) => console.log(`${new Date().toISOString().slice(11, 23)}  ${line}`);

const sim = await launch({
  build: path.join(here, 'dummy-game'),
  headless: !process.argv.includes('--headed'),
  phones: 0,
});
let failed = false;
try {
  log(`sim running at ${sim.url}`);

  // 1. Three players join; the first premium player becomes the master controller.
  const mia = await sim.addPhone({ nickname: 'Mia' });
  const leo = await sim.addPhone({ nickname: 'Leo' });
  const zoe = await sim.addPhone({ nickname: 'Zoe', premium: true });
  const master = await sim.screen.evaluate(() => airconsole.getMasterControllerDeviceId());
  log(`3 phones connected, master is #${master}`);
  if (master !== zoe.id) throw new Error(`expected the premium phone #${zoe.id} to be master, got #${master}`);

  // 2. Mia taps the button; the screen echoes back to her only.
  await mia.tap('Tap me');
  const echo = await mia.waitForMessage({ type: 'echo' });
  log(`Mia got ${JSON.stringify(echo.data)}`);

  // 3. Leo draws a stroke on the canvas pad with real touch input; the screen broadcasts the score.
  await leo.drag({ x: 40, y: 250 }, { x: 300, y: 420 }, { steps: 12, duration: 300 });
  const score = await sim.waitForMessage({ type: 'score' });
  log(`score broadcast: ${JSON.stringify(score.data)}`);
  await sim.screenshot(path.join(out, '01-after-drag.png'));

  // 4. Leo's phone drops (bad wifi) and comes back with the same device id.
  await sim.dropPhone(leo);
  log(`Leo dropped; connected: ${sim.phones().map((p) => p.id).join(', ')}`);
  await sim.reconnect(leo.id);
  log(`Leo is back as #${leo.id}`);

  // 5. The AirConsole menu pauses the game, then resumes it.
  await sim.pause();
  await sim.screenshot(path.join(out, '02-paused.png'));
  await sim.resume();

  // 6. Between rounds the screen shows an ad.
  await sim.screen.evaluate(() => airconsole.showAd());
  await sim.waitForEvent({ type: 'ad', phase: 'complete' }, { timeout: 5000 });
  log(`ads shown: ${sim.ads().length}`);
  await sim.screenshot(path.join(out, '03-screen.png'), { of: 'screen' });

  log(`messages exchanged: ${sim.messages().length}`);
  const errors = sim.consoleErrors();
  if (errors.length) throw new Error(`console errors:\n${errors.map((e) => `  ${e.type}: ${e.text}`).join('\n')}`);
  log(`no console errors; screenshots in ${path.relative(process.cwd(), out)}`);
} catch (error) {
  failed = true;
  console.error(`PLAYTEST FAILED: ${error.message}`);
  await sim.screenshot(path.join(out, 'failure.png')).catch(() => {});
} finally {
  await sim.close();
}
process.exitCode = failed ? 1 : 0;
