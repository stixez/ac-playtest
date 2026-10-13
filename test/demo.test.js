// The demo game (examples/demo-game) plays headless: phones join, steer by drag, fire, and someone scores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useBrowser, until } from './support/helpers.js';
import { DEMO, playUntilScore } from '../examples/demo-playtest.mjs';

const newSim = useBrowser();

test('demo game: 3 phones join, steer by drag, fire, and a point is scored without console errors', async (t) => {
  const sim = await newSim(t, { build: DEMO, phones: 3 });
  const [hunter, ...others] = sim.phones();
  for (const phone of sim.phones()) {
    const you = await phone.waitForMessage((m) => m.data.t === 'you');
    assert.match(you.data.color, /^#[0-9a-f]{6}$/);
  }
  const ships = async () => (await sim.screen.evaluate(() => window.demo.state())).ships;
  await until(async () => (await ships()).every((s) => s.flying));

  const before = (await ships()).find((s) => s.id === others[0].id);
  await others[0].drag({ x: 180, y: 220 }, { x: 120, y: 160 }, { steps: 5, hold: 300 });
  const steer = sim.messages({ from: others[0].id }).filter((m) => m.data.t === 's');
  assert.ok(steer.length >= 2 && steer.length <= 20, `throttled steering messages: ${steer.length}`);
  assert.notEqual((await ships()).find((s) => s.id === others[0].id).angle, before.angle);

  assert.ok(await playUntilScore(sim, hunter) >= 1);
  assert.ok(sim.messages({ from: hunter.id }).some((m) => m.data.t === 'f'));
  assert.ok(sim.events({ type: 'vibrate' }).length >= 1, 'the hit phone vibrated');
  assert.deepEqual(sim.consoleErrors(), []);
});

test('demo game: phones that connect before their page loads still get their ship colour', async (t) => {
  const sim = await newSim(t, { build: DEMO, phones: 2, joinBeforeLoad: 'always', loadDelay: 300 });
  for (const phone of sim.phones()) {
    await phone.waitForMessage((m) => m.data.t === 'you');
    await until(async () => (await phone.evaluate(() => document.getElementById('name').textContent)) !== 'Connecting…');
  }
  assert.deepEqual(sim.consoleErrors(), []);
});
