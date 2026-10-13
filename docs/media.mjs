// Regenerates the README media from examples/demo-game, using ac-playtest itself:
//   docs/demo.gif  ~7 s of three phones joining, steering by drag and firing until someone scores
//   docs/hero.png  the sim page mid-action: a phone steering with its joystick while another one fires
// Needs ffmpeg on the PATH. Run: node docs/media.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from 'ac-playtest';
import { DEMO, huntOnce, zoneCentre } from '../examples/demo-playtest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 1514, height: 518 };          // the screen plus three portrait phones in one row (scale 0.6)
const CLIP = { x: 0, y: 0, width: 1514, height: 512 };  // without the event log bar
const MAX_SCENE_MS = 7600;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// One take: record the sim page (CDP screencast, so frames come at the browser's pace) while three phones join
// and play until a point is scored.
async function take() {
  const sim = await launch({ build: DEMO, scale: 0.6, viewport: VIEWPORT });
  const frames = [];
  let recording = true;
  const cdp = await sim.cdp();
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    if (recording) frames.push({ time: metadata.timestamp * 1000, image: Buffer.from(data, 'base64') });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  try {
    const start = Date.now();
    await pause(700); // the empty arena: "Waiting for players"
    const phones = [];
    for (const nickname of ['Mia', 'Leo', 'Zoe']) {
      phones.push(await sim.addPhone({ nickname }));
      await pause(250);
    }
    const centres = await Promise.all(phones.map(zoneCentre));
    const scored = () => sim.screen.evaluate(() => window.demo.state().ships.some((s) => s.score > 0));
    let scoredAt = 0;
    for (let turn = 0; !scoredAt && Date.now() - start < MAX_SCENE_MS - 1200; turn++) {
      const i = turn % phones.length;
      await huntOnce(sim, phones[i], centres[i]);
      if (await scored()) scoredAt = Date.now();
    }
    if (scoredAt) await pause(1100); // the burst and "+1"
    recording = false;
    await cdp.send('Page.stopScreencast');
    return { frames, start, scoredAt, errors: sim.consoleErrors() };
  } finally {
    recording = false;
    await sim.close();
  }
}

// The hero shot: right after the three ships have flown in (well spread around the arena), Leo holds his
// joystick (touch) while the ship with the longest clear line of fire holds FIRE (mouse, which doesn't disturb
// the touch): a steering phone, a pressed button and bullets in flight.
async function heroShot() {
  const sim = await launch({ build: DEMO, scale: 0.6, viewport: VIEWPORT });
  try {
    const phones = [];
    for (const nickname of ['Mia', 'Leo', 'Zoe']) {
      phones.push(await sim.addPhone({ nickname }));
      await pause(150);
    }
    const leo = phones[1];
    await sim.screen.frame.waitForFunction(() => window.demo.state().ships.every((s) => s.flying));
    const { ships } = await sim.screen.evaluate(() => window.demo.state());
    const clearAhead = (s) => {
      let d = 0;
      while (d < 1200 && s.x + Math.cos(s.angle) * d > 0 && s.x + Math.cos(s.angle) * d < 1280 &&
        s.y + Math.sin(s.angle) * d > 0 && s.y + Math.sin(s.angle) * d < 720) d += 10;
      return d;
    };
    const shooter = ships.filter((s) => s.id !== leo.id).sort((a, b) => clearAhead(b) - clearAhead(a))[0];
    const firing = phones.find((p) => p.id === shooter.id);
    const centre = await zoneCentre(leo);
    const steering = leo.drag(centre, { x: centre.x + 42, y: centre.y - 30 }, { steps: 6, duration: 120, hold: 1000 });
    const button = await firing.toPage('#fire');
    await sim.page.mouse.move(button.x, button.y);
    await sim.page.mouse.down();
    await pause(330);
    const png = await sim.page.screenshot({ clip: CLIP });
    await sim.page.mouse.up();
    await steering;
    if (sim.consoleErrors().length) throw new Error(`console errors: ${JSON.stringify(sim.consoleErrors())}`);
    return png;
  } finally {
    await sim.close();
  }
}

let result;
for (let attempt = 1; attempt <= 8 && !result; attempt++) {
  const t = await take();
  if (t.errors.length) throw new Error(`console errors: ${JSON.stringify(t.errors)}`);
  console.log(`take ${attempt}: ${t.frames.length} frames, ${t.scoredAt ? `scored after ${t.scoredAt - t.start} ms` : 'no score'}`);
  if (t.scoredAt) result = t;
}
if (!result) throw new Error('no take with a score; run it again');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-playtest-media-'));
try {
  const frames = result.frames.filter((f) => f.time >= result.start - 50);
  const list = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `f${String(i).padStart(4, '0')}.jpg`);
    fs.writeFileSync(file, f.image);
    const next = frames[i + 1] ? frames[i + 1].time : f.time + 100;
    list.push(`file '${file}'`, `duration ${((next - f.time) / 1000).toFixed(3)}`);
  });
  list.push(`file '${path.join(dir, `f${String(frames.length - 1).padStart(4, '0')}.jpg`)}'`);
  fs.writeFileSync(path.join(dir, 'frames.txt'), list.join('\n') + '\n');
  fs.writeFileSync(path.join(here, 'hero.png'), await heroShot());
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'),
    '-vf', `crop=${CLIP.width}:${CLIP.height}:0:0,fps=15,scale=800:-1:flags=lanczos,split[a][b];` +
      '[a]palettegen=max_colors=160:stats_mode=diff[p];' +
      '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', path.join(here, 'demo.gif')]);
  const kb = (f) => Math.round(fs.statSync(path.join(here, f)).size / 1024);
  console.log(`docs/demo.gif ${kb('demo.gif')} KB, docs/hero.png ${kb('hero.png')} KB`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
