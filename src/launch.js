// launch(): serve a build, open the sim page in Chromium (Playwright) and return a Sim to script the playtest.
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';
import { Device } from './device.js';
import { messageMatcher, eventMatcher, describeFilter } from './match.js';

const MAX_EVENTS = 200000;

/**
 * Serves `build`, opens the simulated platform in Chromium and waits for the screen's AirConsole API.
 * See index.d.ts for every option.
 * @param {import('../index').LaunchOptions} options
 * @returns {Promise<Sim>}
 */
export async function launch(options = {}) {
  if (!options.build) throw new Error('launch({ build }) needs the build folder (with screen.html and controller.html)');
  const {
    build, path: gamePath, phones = 0, headless = true, port = 0, apiVersion, api = 'builtin',
    browser: sharedBrowser, channel, executablePath, browserArgs, mute = true,
    readyTimeout = 60000, timeout = 10000, phoneTimeout = 30000, viewport, log,
  } = options;
  const platform = {
    code: options.code, screenSize: options.screenSize, phoneSize: options.phoneSize, scale: options.scale ?? 1,
    adDuration: options.adDuration, adFill: options.adFill, latency: options.latency, language: options.language,
    serverTimeOffset: options.serverTimeOffset, translations: options.translations,
    gameConfiguration: options.gameConfiguration, gameSafeArea: options.gameSafeArea, persistentData: options.persistentData,
    joinBeforeLoad: options.joinBeforeLoad, seed: options.seed, loadDelay: options.loadDelay,
    earlyMessages: options.earlyMessages,
  };
  if (platform.joinBeforeLoad !== undefined && !['never', 'always', 'random'].includes(platform.joinBeforeLoad)) {
    throw new Error(`joinBeforeLoad must be 'never', 'always' or 'random', not ${JSON.stringify(platform.joinBeforeLoad)}`);
  }
  if (platform.earlyMessages !== undefined && !['drop', 'queue'].includes(platform.earlyMessages)) {
    throw new Error(`earlyMessages must be 'drop' or 'queue', not ${JSON.stringify(platform.earlyMessages)}`);
  }
  if (platform.seed !== undefined && !Number.isFinite(platform.seed)) {
    throw new Error(`seed must be a number, not ${JSON.stringify(platform.seed)}`);
  }
  if (platform.loadDelay !== undefined && !(Number.isFinite(platform.loadDelay) && platform.loadDelay >= 0)) {
    throw new Error(`loadDelay must be a number of ms >= 0, not ${JSON.stringify(platform.loadDelay)}`);
  }
  for (const key of Object.keys(platform)) if (platform[key] === undefined) delete platform[key];

  const server = await startServer({ build, path: gamePath, port, apiVersion, api, log });
  let browser;
  let context;
  try {
    browser = sharedBrowser || await launchBrowser({ headless, channel, executablePath, mute, args: browserArgs });
    context = await browser.newContext({
      viewport: viewport || defaultViewport(platform),
      hasTouch: true, // phones get real touch input (touchscreen.tap, Input.dispatchTouchEvent)
    });
    const page = await context.newPage();
    const sim = new Sim({
      server, browser, ownsBrowser: !sharedBrowser, context, page, timeout, phoneTimeout,
      loadDelay: platform.loadDelay ?? 1000,
    });
    await page.exposeFunction('__acPlaytestEmit', (event) => sim._record(event));
    await page.addInitScript((config) => {
      if (window === window.top) window.__AC_PLAYTEST_CONFIG__ = config;
    }, platform);
    await page.goto(server.simUrl);
    await sim.waitForEvent({ type: 'ready', device: 0 }, { timeout: readyTimeout }).catch(() => {
      throw new Error(`The screen did not create an AirConsole object within ${readyTimeout} ms. Check that ` +
        'screen.html loads the AirConsole API script (https://www.airconsole.com/api/airconsole-<version>.js) and ' +
        `calls new AirConsole(). Console errors: ${JSON.stringify(sim.consoleErrors().map((e) => e.text))}`);
    });
    await sim.screen.attach();
    // One phone at a time until the others were told about it, so ids and connect order are deterministic; then
    // wait for all pages together, so phones announced before loading are in that state at the same time.
    const joins = [];
    for (let i = 0; i < phones; i++) {
      const join = await sim._startJoin((p) => window.__acPlatform.addPhone(p), undefined, {});
      await join.connected;
      joins.push(join);
    }
    await Promise.all(joins.map((join) => join.phone));
    return sim;
  } catch (e) {
    await context?.close().catch(() => {});
    if (!sharedBrowser) await browser?.close().catch(() => {});
    await server.close();
    throw e;
  }
}

// Pixel sizes of the sim page layout (src/sim/sim.html): header, main padding and gaps, tile padding and label.
const LAYOUT = { header: 36, pad: 10, gap: 10, tilePad: 4, label: 22, scrollbar: 16 };

/**
 * A viewport that shows the screen and, beside it, two phones in either orientation without scrolling:
 * portrait phones side by side, landscape phones one above the other. More phones wrap below (Device input
 * scrolls the page as needed).
 */
function defaultViewport({ screenSize = { width: 1280, height: 720 }, phoneSize = { width: 360, height: 640 }, scale = 1 }) {
  const { header, pad, gap, tilePad, label, scrollbar } = LAYOUT;
  const tileW = (w) => Math.ceil(w * scale) + 2 * tilePad;
  const tileH = (h) => Math.ceil(h * scale) + 2 * tilePad + label;
  const short = Math.min(phoneSize.width, phoneSize.height);
  const long = Math.max(phoneSize.width, phoneSize.height);
  const phonesWidth = Math.max(2 * tileW(short) + gap, tileW(long));
  const phonesHeight = Math.max(tileH(long), 2 * tileH(short) + gap);
  return {
    width: 2 * pad + tileW(screenSize.width) + gap + phonesWidth + scrollbar,
    height: header + 2 * pad + Math.max(tileH(screenSize.height), phonesHeight),
  };
}

export class Sim {
  constructor({ server, browser, ownsBrowser, context, page, timeout, phoneTimeout, loadDelay }) {
    /** The local HTTP server ({origin, port, root, simUrl, close}). */
    this.server = server;
    /** Playwright objects, for anything the helpers don't cover. */
    this.browser = browser;
    this.context = context;
    this.page = page;
    /** URL of the sim page. */
    this.url = server.simUrl;
    /** The screen (device 0). */
    this.screen = new Device(this, 0);
    this._ownsBrowser = ownsBrowser;
    this._timeout = timeout;
    this._phoneTimeout = phoneTimeout;
    this._loadDelay = loadDelay;
    this._phones = new Map();
    this._connected = new Set();
    this._events = [];
    this._waiters = new Set();
    this._console = [];
    this._closed = false;
    page.on('console', (msg) => this._console.push({
      type: msg.type(), text: msg.text(), url: msg.location().url, time: Date.now(),
    }));
    page.on('pageerror', (error) => this._console.push({
      type: 'pageerror', text: String(error && error.message), stack: error && error.stack, time: Date.now(),
    }));
  }

  // ---- devices

  /**
   * Connects a new phone (loads controller.html in a new frame) and resolves once its AirConsole API is ready
   * and the other devices were told (onConnect). With `joinBeforeLoad: true` the others are told first and the
   * page loads `loadDelay` ms later (see README, "Testing robustness"); this still resolves when the page is ready.
   * `timeout` (default: launch's phoneTimeout, 30000) does not include loadDelay.
   * @param {{nickname?: string, uid?: string, premium?: boolean, language?: string, joinBeforeLoad?: boolean,
   *   timeout?: number}} [profile]
   */
  async addPhone(profile = {}) {
    const { timeout, ...rest } = profile;
    const join = await this._startJoin((p) => window.__acPlatform.addPhone(p), timeout, rest);
    return join.phone;
  }

  /** Disconnects a phone: its frame is removed, the others get onDeviceStateChange(id, undefined) + onDisconnect. */
  async dropPhone(id) {
    id = idOf(id);
    const since = this.mark();
    const result = await this.page.evaluate((i) => window.__acPlatform.dropPhone(i), id);
    if (!result) throw new Error(`dropPhone(${id}): no such phone (or it is already disconnected)`);
    await this.waitForEvent((e) => e.device === id && (e.type === 'disconnect' || e.type === 'removed'), { since });
  }

  /**
   * Reconnects a dropped phone with its old device id, nickname and uid (a fresh controller.html).
   * `joinBeforeLoad` applies to this join only.
   */
  async reconnect(id, { timeout, joinBeforeLoad } = {}) {
    id = idOf(id);
    const join = await this._startJoin(([i, o]) => window.__acPlatform.reconnect(i, o) && i, timeout,
      [id, { joinBeforeLoad }]);
    if (join.id === false) throw new Error(`reconnect(${id}): unknown phone, or it is still connected`);
    return join.phone;
  }

  /**
   * Starts a join with `start` (run in the sim page with `arg`; returns the phone id, or false). Resolves with
   * {id, connected, phone}: `connected` settles when the other devices were told, `phone` when the page's API is
   * ready too (with the attached Device). Both reject at once if the phone is dropped first.
   */
  async _startJoin(start, timeout = this._phoneTimeout, arg) {
    const since = this.mark();
    const id = await this.page.evaluate(start, arg);
    if (id === false) return { id };
    const limit = timeout + this._loadDelay;
    const seen = { connect: false, ready: false };
    const step = (want) => (e) => {
      if (e.seq <= since || e.device !== id) return undefined;
      if (e.type === 'disconnect' || e.type === 'removed') {
        return { error: new Error(`Phone ${id} was dropped before its page loaded`) };
      }
      if (e.type === 'connect' || e.type === 'ready') seen[e.type] = true;
      return want.every((w) => seen[w]) ? { value: true } : undefined;
    };
    const timedOut = (error) => {
      if (!/^Timed out/.test(error.message)) throw error;
      throw new Error(`Phone ${id} did not connect within ${limit} ms. Does controller.html load the AirConsole ` +
        `API and call new AirConsole()? Console errors: ${JSON.stringify(this.consoleErrors().map((e) => e.text))}`);
    };
    // Both orders happen: normally the page's API is ready first; with joinBeforeLoad the announcement is.
    const connected = this._watch(step(['connect']), limit, `phone ${id} to connect`).catch(timedOut);
    const phone = this._watch(step(['connect', 'ready']), limit, `phone ${id} to load`).catch(timedOut)
      .then(async () => {
        let device = this._phones.get(id);
        if (!device) {
          device = new Device(this, id);
          this._phones.set(id, device);
        }
        await device.attach();
        return device;
      });
    connected.catch(() => {}); // callers may only await `phone`; it rejects with the same error
    return { id, connected, phone };
  }

  /** The Device for an id (0 = screen). */
  device(id) {
    if (id === 0) return this.screen;
    const phone = this._phones.get(id);
    if (!phone) throw new Error(`No phone with id ${id}`);
    return phone;
  }

  /** Connected phones whose page has loaded, by id (never a dropped phone's detached Device). */
  phones() {
    return [...this._connected].filter((id) => this._phones.get(id)?.frame).sort((a, b) => a - b)
      .map((id) => this.device(id));
  }

  // ---- platform controls

  /** AirConsole pause (e.g. the platform menu is open): the screen gets onPause. */
  async pause() { await this.page.evaluate(() => window.__acPlatform.pause()); }

  /** The screen gets onResume. */
  async resume() { await this.page.evaluate(() => window.__acPlatform.resume()); }

  /** Makes a phone premium (every device gets onPremium). */
  async setPremium(id) { await this.page.evaluate((i) => window.__acPlatform.setPremium(i), idOf(id)); }

  /** Changes a phone's nickname (others get onDeviceStateChange + onDeviceProfileChange). */
  async setNickname(id, nickname) {
    await this.page.evaluate(([i, n]) => window.__acPlatform.setNickname(i, n), [idOf(id), nickname]);
  }

  /** Whether showAd() finds an ad (onAdShow + onAdComplete(true)) or not (only onAdComplete(false)). */
  async setAdFill(fill) { await this.page.evaluate((f) => window.__acPlatform.setAdFill(f), fill); }

  /** Delivers device motion data to a phone's onDeviceMotion. */
  async deviceMotion(id, data) {
    await this.page.evaluate(([i, d]) => window.__acPlatform.deviceMotion(i, d), [idOf(id), data]);
  }

  /** Sends a new safe area to the screen (onSetSafeArea). */
  async setSafeArea(area) { await this.page.evaluate((a) => window.__acPlatform.setSafeArea(a), area); }

  /** Snapshot of the platform: devices, active players, paused, ads, master, stored high scores and data. */
  state() { return this.page.evaluate(() => window.__acPlatform.state()); }

  // ---- recorded events and messages

  _record(event) {
    if (this._closed) return;
    this._events.push(event);
    if (this._events.length > MAX_EVENTS) this._events.splice(0, this._events.length - MAX_EVENTS);
    if (event.type === 'connect') this._connected.add(event.device);
    if (event.type === 'disconnect' || event.type === 'removed') {
      this._connected.delete(event.device);
      const phone = this._phones.get(event.device);
      if (phone) phone.frame = null; // its frame is gone; reconnect attaches the new one
    }
    let changed = [event];
    if (event.type === 'messageDelivered') {
      // A queued message reached its phone: from now on it counts as delivered to it (see match.js reached()).
      const message = this._events.findLast((e) => e.type === 'message' && e.seq === event.message);
      if (message) {
        (message.delivered ||= []).push(event.to);
        changed = [event, message];
      }
    }
    for (const waiter of this._waiters) {
      for (const e of changed) {
        const result = waiter.step(e);
        if (result) { waiter.finish(result); break; }
      }
    }
  }

  /** Sequence number of the latest recorded event; pass it as `since` to only consider newer ones. */
  mark() { return this._events.length ? this._events[this._events.length - 1].seq : 0; }

  /**
   * Everything the platform recorded: ready, join, connect, disconnect, message, custom, players, ad, pause,
   * resume, premium, profile, navigate, vibrate, orientation, immersive, jserror, ... (see README).
   */
  events(filter) { return this._events.filter(eventMatcher(filter)); }

  /** Messages as they left the sender ({seq, time, from, to: id | 'all', data}), after the JSON round-trip. */
  messages(filter) {
    const match = messageMatcher(filter);
    return this._events.filter((e) => e.type === 'message' && match(e));
  }

  lastMessage(filter) { return this.messages(filter).at(-1); }

  /** Resolves with the first event matching `filter` (recorded after `since`, default: any time). */
  waitForEvent(filter, { timeout = this._timeout, since = 0 } = {}) {
    const match = eventMatcher(filter);
    return this._waitFor((e) => e.seq > since && match(e), timeout, `event ${describeFilter(filter)}`);
  }

  /** Resolves with the first message matching `filter` (recorded after `since`, default: any time). */
  waitForMessage(filter, { timeout = this._timeout, since = 0 } = {}) {
    const match = messageMatcher(filter);
    return this._waitFor((e) => e.type === 'message' && e.seq > since && match(e), timeout,
      `message ${describeFilter(filter)}`);
  }

  _waitFor(match, timeout, what) {
    return this._watch((e) => (match(e) ? { value: e } : undefined), timeout, what);
  }

  /**
   * Feeds every recorded event (past, then new) to `step` until it returns {value} or {error}; times out after
   * `timeout` ms. The waiter is always removed when it settles.
   */
  _watch(step, timeout, what) {
    for (const e of this._events) {
      const result = step(e);
      if (result) return result.error ? Promise.reject(result.error) : Promise.resolve(result.value);
    }
    if (this._closed) return Promise.reject(new Error('sim is closed'));
    return new Promise((resolve, reject) => {
      const waiter = {
        step,
        finish: (result) => {
          clearTimeout(waiter.timer);
          this._waiters.delete(waiter);
          if (result.error) reject(result.error);
          else resolve(result.value);
        },
      };
      waiter.timer = setTimeout(() => waiter.finish({ error: new Error(`Timed out after ${timeout} ms waiting for ${what}`) }),
        timeout);
      this._waiters.add(waiter);
    });
  }

  /** One entry per showAd(): {id, requestedAt, shown, completedAt, ignored}. */
  ads() {
    const ads = new Map();
    for (const e of this._events) {
      if (e.type !== 'ad') continue;
      if (e.phase === 'request') ads.set(e.id, { id: e.id, requestedAt: e.time, shown: undefined, completedAt: undefined });
      const ad = ads.get(e.id);
      if (e.phase === 'show') ad.shown = true;
      if (e.phase === 'complete') Object.assign(ad, { shown: e.shown, completedAt: e.time });
      if (e.phase === 'ignored') ad.ignored = true;
    }
    return [...ads.values()];
  }

  // ---- console

  /** Every console message and uncaught page error from the sim page and all device frames. */
  consoleMessages() { return this._console.slice(); }

  /**
   * console.error() calls, uncaught exceptions (type 'pageerror') and errors the AirConsole API reported to the
   * platform (type 'jserror', with the device id), from all frames, oldest first.
   * @param {{ignore?: (RegExp | string)[]}} [opts] drop entries whose text matches
   */
  consoleErrors({ ignore = [] } = {}) {
    const errors = this._console.filter((m) => m.type === 'error' || m.type === 'pageerror');
    // A page whose window.onerror returns true (the Unity WebGL template does) hides uncaught errors from the
    // console and from Playwright. The AirConsole API still reports them to the platform: add those reports,
    // skipping the ones Playwright saw as well.
    for (const e of this._events) {
      if (e.type !== 'jserror') continue;
      const text = String(e.message ?? '');
      const seen = errors.some((m) => m.type === 'pageerror' && Math.abs(m.time - e.time) < 2000 && text.endsWith(m.text));
      if (!seen) errors.push({ type: 'jserror', text, url: e.url, device: e.device, time: e.time });
    }
    return errors
      .filter((m) => !ignore.some((p) => (typeof p === 'string' ? m.text.includes(p) : p.test(m.text))))
      .sort((a, b) => a.time - b.time);
  }

  // ---- screenshots, CDP, teardown

  /**
   * PNG screenshot; also written to `file` if given.
   * @param {string} [file]
   * @param {{of?: 'page' | 'screen' | number}} [opts] whole sim page (default), the screen, or one phone id
   */
  async screenshot(file, { of = 'page' } = {}) {
    if (of !== 'page') return this.device(of === 'screen' ? 0 : of).screenshot(file);
    if (file) await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    return this.page.screenshot({ path: file, fullPage: true });
  }

  /** A CDP session on the sim page (Chromium only), created on first use. */
  cdp() {
    this._cdp ||= this.context.newCDPSession(this.page);
    return this._cdp;
  }

  /** Closes the page, the browser (unless it was passed in) and the server. Safe to call twice. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const waiter of this._waiters) waiter.finish({ error: new Error('sim closed') });
    await this.context.close().catch(() => {});
    if (this._ownsBrowser) await this.browser.close().catch(() => {});
    await this.server.close();
  }
}

const idOf = (idOrDevice) => (typeof idOrDevice === 'object' && idOrDevice ? idOrDevice.id : idOrDevice);
