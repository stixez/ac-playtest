// The scripting API: input, message queries, console capture, screenshots, and launch failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { useBrowser, DUMMY, until } from './support/helpers.js';

const newSim = useBrowser();

function tempBuild(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-playtest-build-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('phone.tap by visible text, by selector and by point sends real touch input', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  const [phone] = sim.phones();
  await phone.tap('Tap me');
  await phone.tap('#tap');
  const box = await phone.evaluate(() => {
    const r = document.getElementById('tap').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await phone.tap(box);
  await phone.tap('#tap', { pointerType: 'mouse' });
  const echo = await sim.waitForMessage({ to: phone.id, type: 'echo' });
  assert.equal(echo.data.n, 1);
  await until(() => phone.messages({ type: 'echo' }).length === 4);
  assert.deepEqual(phone.messages({ type: 'echo' }).map((m) => m.data.n), [1, 2, 3, 4]);
  assert.equal(phone.lastMessage().data.n, 4);
  assert.deepEqual(phone.sent().map((m) => m.data.type), ['tap', 'tap', 'tap', 'tap']);
});

test('phone.drag fires pointer events on a canvas, with touch (default) or mouse', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  const [phone] = sim.phones();
  await phone.drag({ x: 60, y: 260 }, { x: 260, y: 420 }, { steps: 8, duration: 80 });
  const end = await sim.waitForMessage((m) => m.data.type === 'drag' && m.data.phase === 'end');
  assert.deepEqual([end.data.dx, end.data.dy, end.data.moves, end.data.cancelled], [200, 160, 8, false]);
  assert.equal(sim.messages({ type: 'drag' })[0].data.pointerType, 'touch');

  const since = sim.mark();
  await phone.drag('#pad', { x: 100, y: 300 }, { pointerType: 'mouse', steps: 4, duration: 0 });
  const start = await sim.waitForMessage((m) => m.data.phase === 'start', { since });
  assert.equal(start.data.pointerType, 'mouse');
  await sim.waitForMessage({ type: 'score' }, { since });
});

test('waitForMessage honours `since` and times out with a readable error', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  const [phone] = sim.phones();
  await phone.tap('Tap me');
  await sim.waitForMessage({ type: 'echo' });
  const mark = sim.mark();
  await assert.rejects(sim.waitForMessage({ type: 'echo' }, { since: mark, timeout: 150 }),
    /Timed out after 150 ms waiting for message \{"type":"echo"\}/);
  const next = phone.waitForMessage({ type: 'echo' }, { since: mark });
  await phone.tap('Tap me');
  assert.equal((await next).data.n, 2);
});

test('phone.send / screen.send inject messages as if the game had sent them', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  const [phone] = sim.phones();
  await phone.send({ type: 'tap', n: 99 });
  const echo = await sim.waitForMessage({ type: 'echo' });
  assert.equal(echo.data.n, 99);
  await sim.screen.send({ type: 'banner' });
  assert.equal((await phone.waitForMessage({ type: 'banner' })).to, 'all');
});

test('consoleErrors collects console.error and uncaught exceptions from every frame', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  const [phone] = sim.phones();
  await sim.screen.evaluate(() => console.error('screen says no'));
  await phone.evaluate(() => setTimeout(() => { throw new Error('phone blew up'); }));
  await until(() => sim.consoleErrors().length >= 2);
  const texts = sim.consoleErrors().map((e) => `${e.type}: ${e.text}`);
  assert.ok(texts.includes('error: screen says no'), texts.join('\n'));
  assert.ok(texts.some((x) => x.startsWith('pageerror:') && x.includes('phone blew up')), texts.join('\n'));
  assert.equal(sim.consoleErrors({ ignore: [/no$/, 'blew up'] }).length, 0);
  // The API also reports uncaught errors to the platform; that report is not counted twice.
  await sim.waitForEvent({ type: 'jserror', device: 1 });
  assert.equal(sim.consoleErrors().filter((e) => e.text.includes('blew up')).length, 1);
});

test('consoleErrors still sees errors that the page hides with window.onerror (as Unity templates do)', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  await sim.screen.evaluate(() => {
    window.onerror = () => true;
    setTimeout(() => { throw new Error('RuntimeError: memory access out of bounds'); });
  });
  const entry = await until(() => sim.consoleErrors().find((e) => e.text.includes('out of bounds')));
  assert.equal(entry.type, 'jserror');
  assert.equal(entry.device, 0);
});

test('screenshots of the page, the screen and a phone are PNG files', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-playtest-shots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await sim.screenshot(path.join(dir, 'page.png'));
  await sim.screenshot(path.join(dir, 'nested/screen.png'), { of: 'screen' });
  await sim.screenshot(path.join(dir, 'phone.png'), { of: 1 });
  for (const f of ['page.png', 'nested/screen.png', 'phone.png']) {
    assert.deepEqual([...fs.readFileSync(path.join(dir, f)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], f);
  }
});

test('setOrientation(landscape) turns the phone frame', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  const [phone] = sim.phones();
  assert.deepEqual(await phone.evaluate(() => [innerWidth, innerHeight]), [360, 640]);
  await phone.evaluate(() => airconsole.setOrientation(AirConsole.ORIENTATION_LANDSCAPE));
  await until(() => phone.evaluate(() => [innerWidth, innerHeight]), { expected: [640, 360] });
});

test('pre-compressed files decode in the browser (Content-Encoding br / gzip)', async (t) => {
  const payload = JSON.stringify({ hello: 'brotli' });
  const build = tempBuild({
    'screen.html': fs.readFileSync(path.join(DUMMY, 'screen.html')),
    'controller.html': fs.readFileSync(path.join(DUMMY, 'controller.html')),
    'Build/data.json.br': zlib.brotliCompressSync(payload),
    'Build/data.json.gz': zlib.gzipSync(payload),
  });
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  const sim = await newSim(t, { build });
  const got = await sim.screen.evaluate(async () => [
    await (await fetch('Build/data.json.br')).json(),
    await (await fetch('Build/data.json.gz')).json(),
  ]);
  assert.deepEqual(got, [{ hello: 'brotli' }, { hello: 'brotli' }]);
});

test('launch fails with a clear message when the screen never creates an AirConsole object', async (t) => {
  const build = tempBuild({ 'screen.html': '<p>no api here</p>', 'controller.html': '<p>nor here</p>' });
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  await assert.rejects(newSim(t, { build, readyTimeout: 500 }), /did not create an AirConsole object within 500 ms/);
});
