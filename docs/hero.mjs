// Regenerates docs/hero.png (the README screenshot) from the example dummy game: node docs/hero.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'ac-playtest';

const here = path.dirname(fileURLToPath(import.meta.url));
const sim = await launch({ build: path.join(here, '../examples/dummy-game'), scale: 0.6 });
try {
  const mia = await sim.addPhone({ nickname: 'Mia' });
  const leo = await sim.addPhone({ nickname: 'Leo', premium: true });
  await mia.tap('Tap me');
  await mia.waitForMessage({ type: 'echo' });
  await leo.drag({ x: 70, y: 230 }, { x: 290, y: 470 }, { steps: 16 });
  await sim.waitForMessage({ type: 'score' });
  await new Promise((r) => setTimeout(r, 300));
  await sim.page.evaluate(() => scrollTo(0, 0));
  const vp = sim.page.viewportSize();
  await sim.page.screenshot({ path: path.join(here, 'hero.png'), clip: { x: 0, y: 0, width: vp.width, height: vp.height } });
} finally {
  await sim.close();
}
