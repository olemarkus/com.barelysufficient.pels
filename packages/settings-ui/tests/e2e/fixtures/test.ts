import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';
import { resolveE2EBaseURL } from './baseUrl';

export const test = base.extend({
  baseURL: async ({ browserName }, use) => {
    void browserName;
    await use(resolveE2EBaseURL());
  },
});
export { expect };
export type { Locator, Page } from '@playwright/test';

// --- Homey host stylesheet (the real app-settings iframe environment) --------
//
// In production the PELS settings UI runs inside Homey's app-settings iframe,
// which injects `manager/webserver/assets/css/homey.css` (captured verbatim in
// `test/fixtures/homey-wrap/`). That host sheet restyles bare native elements
// via `:not(.hy-nostyle)` rules (e.g. the legacy-button rule greys every native
// <button> without an opt-out) — invisible in the desktop light theme, a glaring
// light rectangle in the mobile dark theme. A LOCAL render without it is a lie:
// host-CSS bleed hides behind a clean-looking capture.
//
// `renderTest` below injects that host CSS into every page, so screenshot/render
// specs capture exactly what users see on-device and any future bleed shows up
// in review. Functional specs keep the bare `test` (host CSS could shift the odd
// layout assertion, and they aren't there to judge appearance).
const HOST_FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', // fixtures -> e2e
  '..', // e2e -> tests
  '..', // tests -> packages/settings-ui
  'test',
  'fixtures',
  'homey-wrap',
);
const HOMEY_HOST_CSS = ['homey-host-base.css', 'homey-host-button.css']
  .map((f) => fs.readFileSync(path.join(HOST_FIXTURE_DIR, f), 'utf8'))
  .join('\n');

// Inject the Homey host stylesheet into a page that creates its own context
// (and so can't use the `renderTest` page fixture).
//
// Order matters and is deliberate: in the live iframe Homey's sheet loads AFTER
// the app's own `style.css`, so an equal-specificity tie resolves to Homey (this
// is exactly why the segmented control hardens to (0,4,1) — see style.css). To
// stay faithful we must append the host CSS AFTER our `<link>`, which is why we
// wait for `DOMContentLoaded` (the `<link>` is parsed by then) rather than
// injecting at document-start: injecting earlier would let our sheet win ties it
// loses on-device and could HIDE a real bleed. FOUC is a non-issue here because
// every screenshot is captured after navigation + interactions, long after
// `DOMContentLoaded` has fired and the style is applied.
export const injectHomeyHostCss = async (page: Page): Promise<void> => {
  await page.addInitScript((css) => {
    const inject = () => {
      if (document.getElementById('__homey-host-sim__')) return;
      const style = document.createElement('style');
      style.id = '__homey-host-sim__';
      style.textContent = css;
      document.head.append(style);
    };
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }, HOMEY_HOST_CSS);
};

// Drop-in replacement for `test` whose `page` already carries the Homey host
// stylesheet. Use this for every screenshot / visual-render spec.
export const renderTest = test.extend({
  page: async ({ page }, use) => {
    await injectHomeyHostCss(page);
    await use(page);
  },
});
