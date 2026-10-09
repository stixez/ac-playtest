// Starts Chromium through playwright-core: Playwright's own Chromium if it is installed
// (`npx playwright-core install chromium`), otherwise the locally installed Google Chrome (channel 'chrome').
import { chromium } from 'playwright-core';

const DEFAULT_ARGS = [
  '--autoplay-policy=no-user-gesture-required', // games start music without a click
];

/**
 * @param {object} [opts]
 * @param {boolean} [opts.headless=true]
 * @param {string} [opts.channel]          e.g. 'chrome', 'msedge'; skips the auto-detection
 * @param {string} [opts.executablePath]   explicit browser binary; skips the auto-detection
 * @param {boolean} [opts.mute=true]
 * @param {string[]} [opts.args]           extra command line switches
 */
export async function launchBrowser({ headless = true, channel, executablePath, mute = true, args = [] } = {}) {
  const options = { headless, args: [...DEFAULT_ARGS, ...(mute ? ['--mute-audio'] : []), ...args] };
  if (channel || executablePath) return chromium.launch({ ...options, channel, executablePath });
  try {
    return await chromium.launch(options);
  } catch (bundledError) {
    try {
      return await chromium.launch({ ...options, channel: 'chrome' });
    } catch (chromeError) {
      throw new Error('ac-playtest could not start a browser. Install Playwright\'s Chromium with ' +
        '`npx playwright-core install chromium`, or install Google Chrome.\n' +
        `Playwright Chromium: ${firstLine(bundledError)}\nGoogle Chrome: ${firstLine(chromeError)}`);
    }
  }
}

const firstLine = (e) => String(e && e.message).split('\n')[0];
