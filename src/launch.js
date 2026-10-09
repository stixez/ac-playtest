// launch(): serve a build, open the sim page in Chromium (Playwright) and return a Sim to script the playtest.
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, SIM_PATH } from './server.js';
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
    build, phones = 0, headless = true, port = 0, apiVersion, api = 'builtin',
    browser: sharedBrowser, channel, executablePath, browserArgs, mute = true,
    readyTimeout = 60000, timeout = 10000, viewport, log,
  } = options;
  const platform = {
    code: options.code, screenSize: options.screenSize, phoneSize: options.phoneSize, scale: options.scale ?? 1,
    adDuration: options.adDuration, adFill: options.adFill, latency: options.latency, language: options.language,
    serverTimeOffset: options.serverTimeOffset, translations: options.translations,
    gameConfiguration: options.gameConfiguration, gameSafeArea: options.gameSafeArea, persistentData: options.persistentData,
  };
  for (const key of Object.keys(platform)) if (platform[key] === undefined) delete platform[key];

  const server = await startServer({ build, port, apiVersion, api, log });
  let browser;
  let context;
  try {
    browser = sharedBrowser || await launchBrowser({ headless, channel, executablePath, mute, args: browserArgs });
    context = await browser.newContext({
      viewport: viewport || defaultViewport(platform),
      hasTouch: true, // phones get real touch input (touchscreen.tap, Input.dispatchTouchEvent)
    });
    const page = await context.newPage();
    const sim = new Sim({ server, browser, ownsBrowser: !sharedBrowser, context, page, timeout });
    await page.exposeFunction('__acPlaytestEmit', (event) => sim._record(event));
    await page.addInitScript((config) => {
      if (window === window.top) window.__AC_PLAYTEST_CONFIG__ = config;
    }, platform);
    await page.goto(server.origin + SIM_PATH);
    await sim.waitForEvent({ type: 'ready', device: 0 }, { timeout: readyTimeout }).catch(() => {
      throw new Error(`The screen did not create an AirConsole object within ${readyTimeout} ms. Check that ` +
        'screen.html loads the AirConsole API script (https://www.airconsole.com/api/airconsole-<version>.js) and ' +
        `calls new AirConsole(). Console errors: ${JSON.stringify(sim.consoleErrors().map((e) => e.text))}`);
    });
    await sim.screen.attach();
    for (let i = 0; i < phones; i++) await sim.addPhone();
    return sim;
  } catch (e) {
    await context?.close().catch(() => {});
    if (!sharedBrowser) await browser?.close().catch(() => {});
    await server.close();
    throw e;
  }
}

function defaultViewport({ screenSize = { width: 1280, height: 720 }, phoneSize = { width: 360, height: 640 }, scale = 1 }) {
  // Room for the screen and two portrait phones side by side; more phones wrap below (the page scrolls).
  const short = Math.min(phoneSize.width, phoneSize.height) * scale;
  const long = Math.max(phoneSize.width, phoneSize.height) * scale;
  return {
    width: Math.ceil(screenSize.width * scale + 2 * (short + 18) + 40),
    height: Math.ceil(Math.max(screenSize.height * scale, long) + 100),
  };
}

export class Sim {
  constructor({ server, browser, ownsBrowser, context, page, timeout }) {
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
   * and the other devices were told (onConnect).
   * @param {{nickname?: string, uid?: string, premium?: boolean, language?: string, timeout?: number}} [profile]
   */
  async addPhone(profile = {}) {
    const { timeout = 30000, ...rest } = profile;
    const since = this.mark();
    const id = await this.page.evaluate((p) => window.__acPlatform.addPhone(p), rest);
    return this._whenConnected(id, since, timeout);
  }

  /** Disconnects a phone: its frame is removed, the others get onDeviceStateChange(id, undefined) + onDisconnect. */
  async dropPhone(id) {
    id = idOf(id);
    const since = this.mark();
    const result = await this.page.evaluate((i) => window.__acPlatform.dropPhone(i), id);
    if (!result) throw new Error(`dropPhone(${id}): no such phone (or it is already disconnected)`);
    if (result === 'disconnected') await this.waitForEvent({ type: 'disconnect', device: id }, { since });
  }

  /** Reconnects a dropped phone with its old device id, nickname and uid (a fresh controller.html). */
  async reconnect(id, { timeout = 30000 } = {}) {
    id = idOf(id);
    const since = this.mark();
    const ok = await this.page.evaluate((i) => window.__acPlatform.reconnect(i), id);
    if (!ok) throw new Error(`reconnect(${id}): unknown phone, or it is still connected`);
    return this._whenConnected(id, since, timeout);
  }

  async _whenConnected(id, since, timeout) {
    try {
      await this.waitForEvent({ type: 'connect', device: id }, { since, timeout });
    } catch {
      throw new Error(`Phone ${id} did not connect within ${timeout} ms. Does controller.html load the AirConsole ` +
        `API and call new AirConsole()? Console errors: ${JSON.stringify(this.consoleErrors().map((e) => e.text))}`);
    }
    let phone = this._phones.get(id);
    if (!phone) {
      phone = new Device(this, id);
      this._phones.set(id, phone);
    }
    await phone.attach();
    return phone;
  }

  /** The Device for an id (0 = screen). */
  device(id) {
    if (id === 0) return this.screen;
    const phone = this._phones.get(id);
    if (!phone) throw new Error(`No phone with id ${id}`);
    return phone;
  }

  /** Phones that are currently connected, by id. */
  phones() {
    return [...this._connected].filter((id) => id !== 0).sort((a, b) => a - b).map((id) => this.device(id));
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
    if (event.type === 'disconnect') this._connected.delete(event.device);
    for (const waiter of this._waiters) {
      if (waiter.match(event)) waiter.done(event);
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
    const found = this._events.find(match);
    if (found) return Promise.resolve(found);
    if (this._closed) return Promise.reject(new Error('sim is closed'));
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        done: (event) => { clearTimeout(waiter.timer); this._waiters.delete(waiter); resolve(event); },
        fail: (error) => { clearTimeout(waiter.timer); this._waiters.delete(waiter); reject(error); },
      };
      waiter.timer = setTimeout(() => waiter.fail(new Error(`Timed out after ${timeout} ms waiting for ${what}`)), timeout);
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
    for (const waiter of this._waiters) waiter.fail(new Error('sim closed'));
    await this.context.close().catch(() => {});
    if (this._ownsBrowser) await this.browser.close().catch(() => {});
    await this.server.close();
  }
}

const idOf = (idOrDevice) => (typeof idOrDevice === 'object' && idOrDevice ? idOrDevice.id : idOrDevice);
