// One AirConsole device in the sim: the screen (id 0) or a phone. Wraps its Playwright frame and offers input
// helpers that send real (trusted) touch or mouse input, so pointer, touch and click handlers all fire as on a phone.
import fs from 'node:fs/promises';
import path from 'node:path';
import { messageMatcher } from './match.js';

// Strings that are Playwright selectors rather than visible text.
const SELECTOR = /^(css=|xpath=|text=|role=|id=|data-testid=|internal:|#|\.|\[|\/\/)/;

export class Device {
  /** @param {import('./launch.js').Sim} sim @param {number} id */
  constructor(sim, id) {
    this.sim = sim;
    this.id = id;
    /** The device's Playwright Frame (replaced on reconnect). */
    this.frame = null;
  }

  /** The sim page (the top-level page hosting every device frame). */
  get page() { return this.sim.page; }

  get isScreen() { return this.id === 0; }

  /** Playwright locator of this device's <iframe> element in the sim page. */
  get frameElement() {
    return this.page.locator(this.isScreen ? '#ac-screen' : `#ac-phone-${this.id}`);
  }

  async attach() {
    const handle = await this.frameElement.elementHandle();
    this.frame = await handle.contentFrame();
    await handle.dispose();
    if (!this.frame) throw new Error(`device ${this.id}: frame not found`);
  }

  /**
   * A Playwright Locator in this device's frame. Strings starting with `#`, `.`, `[`, `//` or a Playwright engine
   * prefix (`css=`, `text=`, `role=`, `xpath=` ...) are selectors; any other string is visible text (substring,
   * case-insensitive). Locators pass through.
   */
  locator(target) {
    if (typeof target !== 'string') return target;
    if (SELECTOR.test(target)) return this.frame.locator(target).first();
    return this.frame.getByText(target).locator('visible=true').first();
  }

  /**
   * Taps an element (see locator()) or a point `{x, y}` in this device's CSS pixels.
   * @param {string | import('playwright-core').Locator | {x: number, y: number}} target
   * @param {{pointerType?: 'touch' | 'mouse', timeout?: number}} [opts]
   */
  async tap(target, { pointerType = 'touch', timeout } = {}) {
    if (isPoint(target)) {
      const p = await this.toPage(target);
      if (pointerType === 'mouse') await this.page.mouse.click(p.x, p.y);
      else await this.page.touchscreen.tap(p.x, p.y);
      return;
    }
    const loc = this.locator(target);
    if (pointerType === 'mouse') await loc.click({ timeout });
    else await loc.tap({ timeout });
  }

  /**
   * Drags from one point to another with trusted touch (default) or mouse input; works on canvases.
   * `from` / `to` are `{x, y}` in this device's CSS pixels, or elements (their centre).
   * @param {{steps?: number, duration?: number, hold?: number, pointerType?: 'touch' | 'mouse'}} [opts]
   *   steps: intermediate moves (default 10); duration: ms spread over the moves (default 250);
   *   hold: ms to wait at the end point before releasing (default 0).
   */
  async drag(from, to, { steps = 10, duration = 250, hold = 0, pointerType = 'touch' } = {}) {
    const a = await this.toPage(from);
    const b = await this.toPage(to);
    const pause = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);
    const at = (i) => ({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
    if (pointerType === 'mouse') {
      const mouse = this.page.mouse;
      await mouse.move(a.x, a.y);
      await mouse.down();
      for (let i = 1; i <= steps; i++) {
        await pause(duration / steps);
        const p = at(i);
        await mouse.move(p.x, p.y);
      }
      await pause(hold);
      await mouse.up();
      return;
    }
    const cdp = await this.sim.cdp();
    const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }] : [],
    });
    await touch('touchStart', a);
    for (let i = 1; i <= steps; i++) {
      await pause(duration / steps);
      await touch('touchMove', at(i));
    }
    await pause(hold);
    await touch('touchEnd', null);
  }

  /** Maps a point in device CSS pixels, or an element's centre, to sim-page viewport coordinates. */
  async toPage(target) {
    if (isPoint(target)) {
      const frameEl = this.frameElement;
      await frameEl.scrollIntoViewIfNeeded();
      const box = await frameEl.boundingBox();
      const innerWidth = await this.frame.evaluate(() => window.innerWidth);
      const scale = box.width / innerWidth;
      return { x: box.x + target.x * scale, y: box.y + target.y * scale };
    }
    const loc = this.locator(target);
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    if (!box) throw new Error(`device ${this.id}: ${String(target)} is not visible`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Runs a function in this device's frame (Playwright frame.evaluate). */
  evaluate(fn, arg) { return this.frame.evaluate(fn, arg); }

  /** Sends a message as if this device's game had called airconsole.message(to, data) (to: undefined = broadcast). */
  async send(data, to = this.isScreen ? undefined : 0) {
    await this.page.evaluate(([from, t, d]) => window.__acPlatform.inject(from, t, d), [this.id, to, data]);
  }

  /** Messages delivered to this device (sent to it directly, or broadcast by another device). */
  messages(filter) {
    const mine = this.sim.messages({ to: this.id });
    return filter ? mine.filter(messageMatcher(filter)) : mine;
  }

  /** Messages this device sent. */
  sent(filter) {
    const mine = this.sim.messages({ from: this.id });
    return filter ? mine.filter(messageMatcher(filter)) : mine;
  }

  /** The last message delivered to this device (optionally the last one matching `filter`). */
  lastMessage(filter) {
    return this.messages(filter).at(-1);
  }

  /** Waits for a message to this device. Same options as sim.waitForMessage. */
  waitForMessage(filter, opts) {
    const match = messageMatcher(filter);
    return this.sim.waitForMessage((m) => messageMatcher({ to: this.id })(m) && match(m), opts);
  }

  /** PNG screenshot of this device's frame; also written to `file` if given. */
  async screenshot(file) {
    if (file) await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    return this.frameElement.screenshot({ path: file });
  }
}

function isPoint(v) {
  return v != null && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number' &&
    typeof v.click !== 'function';
}
