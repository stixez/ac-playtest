// joinBeforeLoad: a phone can appear in `devices` (onConnect on the others) before its controller page has loaded,
// which AirConsole says can happen. These tests show the dummy game copes and a naive game gets caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useBrowser, callbacks, until } from './support/helpers.js';

const newSim = useBrowser();
const API = '<script src="https://www.airconsole.com/api/airconsole-1.11.0.js"></script>';

// A game whose screen greets each phone in onConnect (naive: assumes "connected" means "controller ready"),
// or, robustly, when the controller says hello from its onReady.
function greetingGame(t, robust) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-playtest-greet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'screen.html'), `${API}<script>
    var airconsole = new AirConsole();
    airconsole.onConnect = function (id) { ${robust ? '' : "airconsole.message(id, { type: 'welcome' });"} };
    airconsole.onMessage = function (from, data) { if (data.type === 'hello') airconsole.message(from, { type: 'welcome' }); };
  </script>`);
  fs.writeFileSync(path.join(dir, 'controller.html'), `${API}<p id="status">Waiting for the screen…</p><script>
    var airconsole = new AirConsole();
    airconsole.onReady = function () { ${robust ? "airconsole.message(AirConsole.SCREEN, { type: 'hello' });" : ''} };
    airconsole.onMessage = function (from, data) {
      if (data.type === 'welcome') document.getElementById('status').textContent = 'Welcome!';
    };
  </script>`);
  return dir;
}

const status = (phone) => phone.evaluate(() => document.getElementById('status').textContent);

test('a naive game that greets phones in onConnect works when phones load first...', async (t) => {
  const sim = await newSim(t, { build: greetingGame(t, false), phones: 2 });
  for (const phone of sim.phones()) await until(async () => (await status(phone)) === 'Welcome!');
});

test('...but is caught by joinBeforeLoad: the greeting goes to a page that has not loaded', async (t) => {
  const sim = await newSim(t, { build: greetingGame(t, false), phones: 2, joinBeforeLoad: 'always', loadDelay: 300 });
  const dropped = sim.events({ type: 'messageDropped' });
  assert.deepEqual(dropped.map((e) => [e.from, e.to, e.data.type]), [[0, 1, 'welcome'], [0, 2, 'welcome']]);
  await new Promise((r) => setTimeout(r, 300));
  for (const phone of sim.phones()) assert.equal(await status(phone), 'Waiting for the screen…');
});

test('the robust version (controller says hello from onReady) passes with joinBeforeLoad', async (t) => {
  const sim = await newSim(t, { build: greetingGame(t, true), phones: 2, joinBeforeLoad: 'always', loadDelay: 300 });
  for (const phone of sim.phones()) await until(async () => (await status(phone)) === 'Welcome!');
  assert.equal(sim.events({ type: 'messageDropped' }).length, 0);
});

test("earlyMessages: 'queue' delivers messages for a not yet loaded phone once its page is ready", async (t) => {
  const sim = await newSim(t, { build: greetingGame(t, false), phones: 1, joinBeforeLoad: 'always',
    loadDelay: 300, earlyMessages: 'queue' });
  assert.deepEqual(sim.events({ type: 'messageQueued' }).map((e) => [e.to, e.data.type]), [[1, 'welcome']]);
  await until(async () => (await status(sim.phones()[0])) === 'Welcome!');
});

test('the dummy game copes with phones that join before they load', async (t) => {
  const sim = await newSim(t, { phones: 3, joinBeforeLoad: 'always', loadDelay: 200 });
  const phones = sim.phones();
  assert.deepEqual(sim.events({ type: 'connect' }).map((e) => e.early), [true, true, true]);
  assert.equal(await sim.screen.evaluate(() => airconsole.getMasterControllerDeviceId()), 1);
  await phones[2].tap('Tap me');
  assert.equal((await phones[2].waitForMessage({ type: 'echo' })).data.n, 1);
  await phones[0].drag('#pad', { x: 200, y: 400 }, { steps: 5, duration: 50 });
  await sim.waitForMessage({ type: 'score' });
  assert.deepEqual(sim.consoleErrors(), []);
});

test("joinBeforeLoad: 'random' is reproducible with a seed, and per-phone choices override it", async (t) => {
  const pattern = async (seed) => {
    const sim = await newSim(t, { phones: 6, joinBeforeLoad: 'random', seed, loadDelay: 50 });
    return sim.events({ type: 'connect' }).map((e) => e.early);
  };
  const a = await pattern(7);
  assert.deepEqual(await pattern(7), a);
  assert.ok(a.includes(true) && a.includes(false), `seed 7 should mix both: ${a}`);

  const sim = await newSim(t, { joinBeforeLoad: 'always', loadDelay: 50 });
  await sim.addPhone({ joinBeforeLoad: false });
  await sim.addPhone();
  assert.deepEqual(sim.events({ type: 'connect' }).map((e) => e.early), [false, true]);
});

test('a phone dropped while still loading disconnects cleanly; reconnect can join early again', async (t) => {
  const sim = await newSim(t, { loadDelay: 2000 });
  const adding = sim.addPhone({ joinBeforeLoad: true, timeout: 500 });
  await sim.waitForEvent({ type: 'connect', device: 1 });
  await sim.dropPhone(1);
  await assert.rejects(adding, /did not connect/);
  await until(async () => (await callbacks(sim.screen)).includes('onDisconnect 1'));
  const back = await sim.reconnect(1, { joinBeforeLoad: true });
  assert.equal(back.id, 1);
  assert.equal(sim.events({ type: 'connect', device: 1 }).at(-1).early, true);
});
