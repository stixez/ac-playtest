// Shared test helpers: one browser per test file, one sim per test.
import { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, launchBrowser } from '../../src/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DUMMY = path.join(ROOT, 'examples/dummy-game');

/** Registers before/after hooks for a shared browser; returns a function that launches a sim on it. */
export function useBrowser() {
  let browser;
  before(async () => { browser = await launchBrowser(); });
  after(async () => { await browser?.close(); });
  return async (t, options = {}) => {
    const sim = await launch({ build: DUMMY, browser, adDuration: 200, ...options });
    t.after(() => sim.close());
    return sim;
  };
}

/**
 * The AirConsole callbacks a dummy-game frame recorded (window.events), as compact strings:
 * objects become "{...}" (or their JSON with `json: true`), undefined stays "undefined".
 */
export function callbacks(device, { json = false, only } = {}) {
  return device.evaluate(([asJson, names]) => window.events
    .filter((e) => !names || names.includes(e[0]))
    .map((e) => [e[0], ...e.slice(1).map((a) => {
      if (a === undefined) return 'undefined';
      if (a !== null && typeof a === 'object') return asJson ? JSON.stringify(a) : '{...}';
      return String(a);
    })].join(' ')), [json, only]);
}

/** Polls `fn` until it returns a truthy value (or `expected` when given); returns the last value. */
export async function until(fn, { timeout = 5000, interval = 25, expected } = {}) {
  const end = Date.now() + timeout;
  let value;
  for (;;) {
    value = await fn();
    const ok = expected === undefined ? !!value : JSON.stringify(value) === JSON.stringify(expected);
    if (ok) return value;
    if (Date.now() > end) {
      throw new Error(`until: timed out; last value ${JSON.stringify(value)}` +
        (expected === undefined ? '' : `, expected ${JSON.stringify(expected)}`));
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Waits until a device's recorded callbacks equal `expected` (helps with asynchronous delivery). */
export function expectCallbacks(device, expected, opts = {}) {
  return until(() => callbacks(device, opts), { expected, timeout: opts.timeout });
}
