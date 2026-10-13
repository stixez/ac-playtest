// A scripted playtest of examples/demo-game (Starlight Scramble). Three phones join; one of them plays like a
// small bot: it reads the ships from the screen, steers toward an opponent with a drag on its joystick and taps
// FIRE until it scores. The run fails on any console error.
//   node examples/demo-playtest.mjs [--headed]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from 'ac-playtest';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEMO = path.join(here, 'demo-game');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The shortest way from a to b on the wrapping arena, a little ahead of where b is flying. */
function aimVector(a, b, size) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (Math.abs(dx) > size.width / 2) dx -= Math.sign(dx) * size.width;
  if (Math.abs(dy) > size.height / 2) dy -= Math.sign(dy) * size.height;
  const lead = Math.hypot(dx, dy) / 760;
  dx += Math.cos(b.angle) * 140 * lead;
  dy += Math.sin(b.angle) * 140 * lead;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Where a phone's joystick zone is centred, in its own CSS pixels. */
export function zoneCentre(phone) {
  return phone.evaluate(() => {
    const r = document.getElementById('zone').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/**
 * One move of a small bot: steer `phone`'s ship toward the nearest other ship with a drag on its joystick, then
 * fire twice. Returns the ship's score before the move (undefined if it couldn't move).
 * @param {import('ac-playtest').Sim} sim
 * @param {import('ac-playtest').Device} phone
 */
export async function huntOnce(sim, phone, centre) {
  const { ships, size } = await sim.screen.evaluate(() => window.demo.state());
  const me = ships.find((s) => s.id === phone.id);
  const others = ships.filter((s) => s.id !== phone.id && s.flying && !s.invulnerable);
  if (!me || !me.flying || !others.length) {
    await pause(200);
    return undefined;
  }
  const near = (s) => Math.hypot(s.x - me.x, s.y - me.y);
  const target = others.reduce((best, s) => (near(s) < near(best) ? s : best));
  const v = aimVector(me, target, size);
  // Pull the floating joystick toward the target and hold it while the ship turns, then fire twice.
  await phone.drag(centre, { x: centre.x + v.x * 50, y: centre.y + v.y * 50 }, { steps: 4, duration: 40, hold: 350 });
  await phone.tap('#fire');
  await pause(120);
  await phone.tap('#fire');
  await pause(250);
  return me.score;
}

/** Lets `phone` hunt until its score goes up; returns the new score. */
export async function playUntilScore(sim, phone, { attempts = 40 } = {}) {
  const score = async () => (await sim.screen.evaluate(() => window.demo.state())).ships.find((s) => s.id === phone.id).score;
  const start = await score();
  const centre = await zoneCentre(phone);
  for (let i = 0; i < attempts; i++) {
    await huntOnce(sim, phone, centre);
    const now = await score();
    if (now > start) return now;
  }
  throw new Error(`phone ${phone.id} did not score in ${attempts} attempts`);
}

async function main() {
  const sim = await launch({ build: DEMO, headless: !process.argv.includes('--headed'), scale: 0.6 });
  try {
    const [mia, leo, zoe] = [await sim.addPhone({ nickname: 'Mia' }), await sim.addPhone({ nickname: 'Leo' }),
      await sim.addPhone({ nickname: 'Zoe' })];
    const you = await mia.waitForMessage((m) => m.data.t === 'you'); // the screen's answer to the phone's hello
    console.log(`3 ships in the arena; ${you.data.name} flies the ${you.data.color} one`);
    // Leo and Zoe drift around; Mia hunts.
    await leo.drag({ x: 180, y: 220 }, { x: 120, y: 180 }, { steps: 5, hold: 200 });
    await zoe.drag({ x: 180, y: 220 }, { x: 240, y: 260 }, { steps: 5, hold: 200 });
    const score = await playUntilScore(sim, mia);
    console.log(`Mia scored: ${score} point(s)`);
    if (sim.events({ type: 'vibrate' }).length) console.log('the hit ship\'s phone vibrated');
    const errors = sim.consoleErrors();
    if (errors.length) throw new Error(`console errors:\n${errors.map((e) => `  ${e.type}: ${e.text}`).join('\n')}`);
    console.log('no console errors');
  } finally {
    await sim.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`DEMO PLAYTEST FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
