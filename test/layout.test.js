// Phones anywhere on the sim page: the default viewport fits the common cases, and input reaches phones that are
// scrolled out of view, even when the controller uses a position:fixed layout (which cannot scroll the outer page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useBrowser, DUMMY } from './support/helpers.js';

const newSim = useBrowser();

// The dummy game, but its controller asks for landscape and lays out in a position:fixed root, like many real
// controllers (Unity templates included).
function fixedLandscapeBuild(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-playtest-fixed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(DUMMY, 'screen.html'), path.join(dir, 'screen.html'));
  const controller = fs.readFileSync(path.join(DUMMY, 'controller.html'), 'utf8')
    .replace('AirConsole.ORIENTATION_PORTRAIT', 'AirConsole.ORIENTATION_LANDSCAPE')
    .replace('</style>', '  body { position: fixed; inset: 0; overflow: hidden; }\n</style>');
  fs.writeFileSync(path.join(dir, 'controller.html'), controller);
  return dir;
}

const LANDSCAPE = { width: 640, height: 360 };
const PORTRAIT = { width: 360, height: 640 };

async function frameBoxes(sim) {
  return sim.page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => {
    const r = f.getBoundingClientRect();
    return { id: f.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }));
}

async function assertAllVisible(sim) {
  const vp = sim.page.viewportSize();
  assert.equal(await sim.page.evaluate(() => scrollY), 0);
  for (const b of await frameBoxes(sim)) {
    assert.ok(b.left >= 0 && b.top >= 0 && b.right <= vp.width && b.bottom <= vp.height,
      `${b.id} ${JSON.stringify(b)} is not inside the ${vp.width}x${vp.height} viewport`);
  }
}

// Taps the button (by text and by point) and drags across the canvas of `phone`; checks the screen got it all.
async function exercise(sim, phone) {
  const since = sim.mark();
  await phone.tap('Tap me');
  await phone.waitForMessage({ type: 'echo' }, { since });
  const button = await phone.evaluate(() => {
    const r = document.getElementById('tap').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const next = sim.mark();
  await phone.tap(button);
  await phone.waitForMessage({ type: 'echo' }, { since: next });
  const pad = await phone.evaluate(() => {
    const r = document.getElementById('pad').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const from = { x: pad.left + 20, y: pad.top + 20 };
  const to = { x: pad.left + pad.width - 20, y: pad.top + pad.height - 20 };
  await phone.drag(from, to, { steps: 6, duration: 60 });
  const end = await sim.waitForMessage((m) => m.from === phone.id && m.data.phase === 'end', { since });
  assert.equal(end.data.cancelled, false);
  assert.equal(end.data.moves, 6);
  assert.equal(end.data.dx, Math.round(to.x) - Math.round(from.x));
}

test('2 landscape phones (640x360, position:fixed controller) fit beside the screen and take input', async (t) => {
  const sim = await newSim(t, { build: fixedLandscapeBuild(t), phones: 2, phoneSize: LANDSCAPE });
  const phones = sim.phones();
  assert.deepEqual(await phones[1].evaluate(() => [innerWidth, innerHeight]), [640, 360]);
  await assertAllVisible(sim);
  await exercise(sim, phones[1]);
  await exercise(sim, phones[0]);
});

test('2 portrait phones fit beside the screen, also after they rotate to landscape', async (t) => {
  const sim = await newSim(t, { phones: 2, phoneSize: PORTRAIT });
  await assertAllVisible(sim);
  await exercise(sim, sim.phones()[1]);
  for (const phone of sim.phones()) await phone.evaluate(() => airconsole.setOrientation('landscape'));
  await sim.page.evaluate(() => scrollTo(0, 0));
  await sim.phones()[1].frame.waitForFunction(() => innerWidth === 640);
  await assertAllVisible(sim);
});

test('6 landscape phones (position:fixed controller): the last one, far below the fold, still takes input', async (t) => {
  const sim = await newSim(t, { build: fixedLandscapeBuild(t), phones: 6, phoneSize: LANDSCAPE });
  const phones = sim.phones();
  const last = (await frameBoxes(sim)).at(-1);
  assert.ok(last.top > sim.page.viewportSize().height, 'the 6th phone starts below the viewport');
  await exercise(sim, phones[5]);
  await exercise(sim, phones[0]); // and back up again
  await exercise(sim, phones[3]);
});

test('game frames cannot go fullscreen and cover the phones', async (t) => {
  const sim = await newSim(t, { phones: 1 });
  assert.equal(await sim.screen.evaluate(() => document.fullscreenEnabled), false);
  // Unity's runtime checks fullscreenEnabled first; a direct request is refused by the browser.
  await assert.rejects(sim.screen.evaluate(() => document.documentElement.requestFullscreen()));
  assert.equal(await sim.page.evaluate(() => document.fullscreenElement), null);
  await assertAllVisible(sim);
});

test('6 portrait phones: the last one, far below the fold, still takes input', async (t) => {
  const sim = await newSim(t, { phones: 6, phoneSize: PORTRAIT });
  const phones = sim.phones();
  await exercise(sim, phones[5]);
  await exercise(sim, phones[0]);
});

test('a phone frame larger than the viewport: input reaches points at both ends', async (t) => {
  const sim = await newSim(t, { build: fixedLandscapeBuild(t), phones: 1, phoneSize: LANDSCAPE,
    viewport: { width: 700, height: 300 } });
  await exercise(sim, sim.phones()[0]);
});
