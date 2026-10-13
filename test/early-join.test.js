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

test('a phone dropped before its page loads makes addPhone reject at once, with a clear error', async (t) => {
  const sim = await newSim(t, { loadDelay: 5000 });
  const adding = sim.addPhone({ joinBeforeLoad: true });
  const rejected = assert.rejects(adding, /Phone 1 was dropped before its page loaded/);
  await sim.waitForEvent({ type: 'connect', device: 1 });
  const started = Date.now();
  await sim.dropPhone(1);
  await rejected;
  assert.ok(Date.now() - started < 2000, 'rejected promptly, not at the timeout');
  assert.equal(sim._waiters.size, 0, 'no waiters left behind');
  await until(async () => (await callbacks(sim.screen)).includes('onDisconnect 1'));
  const back = await sim.reconnect(1, { joinBeforeLoad: true });
  assert.equal(back.id, 1);
  assert.equal(sim.events({ type: 'connect', device: 1 }).at(-1).early, true);
});

test('messages dropped for a phone that has not loaded do not count as delivered to it', async (t) => {
  const sim = await newSim(t, { build: greetingGame(t, false), phones: 1, joinBeforeLoad: 'always', loadDelay: 200 });
  const [phone] = sim.phones();
  assert.equal(sim.messages({ type: 'welcome' }).length, 1, 'the screen did send it');
  assert.deepEqual(phone.messages(), []);
  assert.equal(phone.lastMessage({ type: 'welcome' }), undefined);
  assert.deepEqual(sim.messages({ to: phone.id }), []);
  await assert.rejects(phone.waitForMessage({ type: 'welcome' }, { timeout: 200 }), /Timed out/);
});

test('queued messages count as delivered once they arrive', async (t) => {
  const sim = await newSim(t, { build: greetingGame(t, false), joinBeforeLoad: 'always', loadDelay: 600,
    earlyMessages: 'queue' });
  const adding = sim.addPhone();
  await sim.waitForEvent({ type: 'messageQueued' });
  assert.deepEqual(sim.messages({ to: 1 }), [], 'not delivered yet');
  const welcome = await sim.waitForMessage({ to: 1, type: 'welcome' });
  assert.ok(sim.events({ type: 'ready', device: 1 }).length, 'delivered after the page was ready');
  const phone = await adding;
  assert.equal(phone.lastMessage().seq, welcome.seq);
});

test('phones() never returns a detached device while a dropped phone reconnects', async (t) => {
  const sim = await newSim(t, { phones: 2, loadDelay: 800 });
  const [first] = sim.phones();
  await sim.dropPhone(first);
  const back = sim.reconnect(first.id, { joinBeforeLoad: true });
  await sim.waitForEvent({ type: 'connect', device: first.id, early: true });
  assert.deepEqual(sim.phones().map((p) => p.id), [2], 'announced but not loaded yet');
  const phone = await back;
  assert.deepEqual(sim.phones().map((p) => p.id), [1, 2]);
  assert.equal(await phone.evaluate(() => airconsole.getDeviceId()), 1);
  for (const p of sim.phones()) assert.equal(p.frame.isDetached(), false);
});

test('launch announces early phones together instead of waiting one loadDelay per phone', async (t) => {
  const started = Date.now();
  const sim = await newSim(t, { phones: 3, joinBeforeLoad: 'always', loadDelay: 1500 });
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  const order = sim.events((e) => e.device > 0 && (e.type === 'connect' || e.type === 'ready'))
    .map((e) => `${e.type} ${e.device}`);
  assert.deepEqual(order.slice(0, 3), ['connect 1', 'connect 2', 'connect 3']);
  assert.deepEqual(sim.phones().map((p) => p.id), [1, 2, 3]);
});

test('the phone timeout does not include loadDelay; launch takes a phoneTimeout', async (t) => {
  const sim = await newSim(t, { loadDelay: 1500, phoneTimeout: 1000, joinBeforeLoad: 'always', phones: 1 });
  const phone = await sim.addPhone({ joinBeforeLoad: true, timeout: 1000 });
  assert.equal(phone.id, 2);
});

test('a reconnect override applies to that join only; random keeps drawing from its seed', async (t) => {
  // seed 5 draws: false, false, true, ...
  const sim = await newSim(t, { joinBeforeLoad: 'random', seed: 5, loadDelay: 50 });
  const early = () => sim.events({ type: 'connect', device: 1 }).at(-1).early;
  await sim.addPhone();
  assert.equal(early(), false);
  for (const [override, expected] of [[true, true], [undefined, false], [undefined, true]]) {
    await sim.dropPhone(1);
    await sim.reconnect(1, { joinBeforeLoad: override });
    assert.equal(early(), expected, `reconnect(1, { joinBeforeLoad: ${override} })`);
  }
});

test('profile changes and device motion for a phone that has not loaded are dropped or queued too', async (t) => {
  const dropping = await newSim(t, { loadDelay: 800 });
  const adding = dropping.addPhone({ joinBeforeLoad: true });
  await dropping.waitForEvent({ type: 'connect', device: 1 });
  await dropping.deviceMotion(1, { x: 1 });
  await dropping.setNickname(1, 'Renamed');
  assert.deepEqual(dropping.events({ type: 'messageDropped' }).map((e) => e.action), ['device_motion', 'profile']);
  const phone = await adding;
  assert.equal(await phone.evaluate(() => airconsole.getNickname()), 'Renamed', 'the ready snapshot has it');

  const queueing = await newSim(t, { loadDelay: 800, earlyMessages: 'queue' });
  const adding2 = queueing.addPhone({ joinBeforeLoad: true });
  await queueing.waitForEvent({ type: 'connect', device: 1 });
  await queueing.deviceMotion(1, { x: 2 });
  assert.deepEqual(queueing.events({ type: 'messageQueued' }).map((e) => e.action), ['device_motion']);
  const phone2 = await adding2;
  await until(async () => (await callbacks(phone2, { only: ['onDeviceMotion'], json: true })).length === 1);
  assert.deepEqual(await callbacks(phone2, { only: ['onDeviceMotion'], json: true }), ['onDeviceMotion {"x":2}']);
});

test('seed 0 is a valid seed', async (t) => {
  const pattern = async (seed) => {
    const sim = await newSim(t, { phones: 6, joinBeforeLoad: 'random', seed, loadDelay: 50 });
    return sim.events({ type: 'connect' }).map((e) => (e.early ? 'T' : 'F')).join('');
  };
  assert.equal(await pattern(0), 'TTTTTF');
  assert.equal(await pattern(1), 'FTFFFT');
  await assert.rejects(newSim(t, { seed: 'x' }), /seed must be a number/);
});
