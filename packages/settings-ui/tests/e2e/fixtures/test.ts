import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, expect, type Locator, test as base, type Page } from '@playwright/test';
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
// The full host bundle, in the SAME order Homey's `homey.css` manifest @imports
// it (variables → base → typography → button → form → icon). Injecting only a
// subset (e.g. base + button) would miss bleed from the rest — most notably the
// form sheet, which restyles bare `<input>`s — so captures wouldn't equal the
// real iframe. Exported so the host-bleed regression shares one source of truth.
export const HOMEY_HOST_CSS = [
  'homey-host-variables.css',
  'homey-host-base.css',
  'homey-host-typography.css',
  'homey-host-button.css',
  'homey-host-form.css',
  'homey-host-icon.css',
]
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

// --- Theme/viewport capture matrix ------------------------------------------
//
// Users meet the settings UI in more than one context, and PELS picks the theme
// off the POINTER (not the width): coarse/touch → the mobile DARK theme; fine +
// hover → the desktop LIGHT theme (`@media (hover:hover) and (pointer:fine)`).
// A single light capture is therefore a third of the story. `captureThemes`
// renders a surface across the contexts users actually see, all with the Homey
// host CSS injected:
//   • light-desktop — fine pointer, full app width (480) → light theme
//   • dark-mobile   — touch, tall mobile viewport       → dark theme
//   • light-mobile  — fine pointer, narrow (360)         → light theme, narrow
// chromium-only (the dark variant needs `isMobile`, which Firefox rejects); the
// caller guards with `test.skip(browserName !== 'chromium', …)`.
export const CAPTURE_THEMES = [
  { suffix: 'light-desktop', viewport: { width: 480, height: 1600 }, mobile: false },
  { suffix: 'dark-mobile', viewport: { width: 480, height: 3400 }, mobile: true },
  { suffix: 'light-mobile', viewport: { width: 360, height: 1600 }, mobile: false },
] as const;

export const captureThemes = async (opts: {
  browser: Browser;
  baseURL?: string;
  name: string;
  outDir: string;
  // Runs on the fresh page BEFORE navigation — register `addInitScript` stubs,
  // pin the clock, etc. (anything that must precede the app's first load).
  prepare?: (page: Page) => Promise<void>;
  // Navigates to and readies the surface. Return a Locator to screenshot just
  // that element (e.g. a panel); return nothing to screenshot the page.
  open: (page: Page) => Promise<Locator | undefined | void>;
}): Promise<void> => {
  fs.mkdirSync(opts.outDir, { recursive: true });
  for (const theme of CAPTURE_THEMES) {
    const context = await opts.browser.newContext({
      baseURL: opts.baseURL,
      viewport: theme.viewport,
      // Touch (coarse pointer / no hover) is what flips PELS to the dark theme.
      // Do NOT `setViewportSize`/`fullPage` on the dark variant — both reset the
      // device metrics mid-test and silently drop back to the light canvas.
      ...(theme.mobile ? { isMobile: true, hasTouch: true } : {}),
    });
    try {
      const page = await context.newPage();
      await injectHomeyHostCss(page);
      await opts.prepare?.(page);
      const target = await opts.open(page);
      await page.waitForTimeout(300);
      const dest = path.join(opts.outDir, `${opts.name}.${theme.suffix}.png`);
      if (target) await target.screenshot({ path: dest });
      else await page.screenshot({ path: dest, fullPage: !theme.mobile });
    } finally {
      await context.close();
    }
  }
};
