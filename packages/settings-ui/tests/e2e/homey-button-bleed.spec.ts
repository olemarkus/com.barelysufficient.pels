import { expect, HOMEY_HOST_CSS, test, type Page } from './fixtures/test';

// Regression gate for the Homey host-stylesheet button bleed.
//
// Homey injects `_base.css` into the app-settings iframe. Its "legacy button"
// rule — `button:not(.hy-nostyle):not([class*='homey-button']):not([class*='hy-button'])`
// (specificity (0,3,1), loaded AFTER our stylesheet) — forces light-grey
// `#e7e7e7` / `#555` chrome onto any native <button> without an opt-out class.
// It is invisible in the desktop light theme (greys blend) but a glaring light
// rectangle in our mobile DARK theme, where users actually live. PELS opts every
// native <button> out with the `hy-nostyle` class (enforced by an ESLint guard);
// this test proves the opt-out actually defeats the host rule at runtime by
// injecting the captured prod host CSS over the real dark render and asserting no
// native <button> ends up wearing the host's grey. Self-contained (injects the
// committed fixture itself), so it runs in the normal chromium-mobile CI project
// with no special server mode.
//
// It ALSO guards the sibling label defence: the same host sheet has a
// `label:not(.hy-nostyle)` rule that would uppercase/grey bare <label>s, but PELS
// neutralises it globally with `label { … !important }` (style.css). Labels need
// no per-element opt-out — this test just confirms that override still holds.

const HOST_GREY = 'rgb(231, 231, 231)'; // #e7e7e7 — the host legacy-button background

const FIXED_NOW_MS = Date.UTC(2026, 4, 15, 12, 0, 0);
const HOUR = 3_600_000, DAY = 24 * HOUR;
type Outcome = 'met' | 'missed' | 'abandoned';
const makeEntry = (p: { id: string; deviceId: string; deviceName: string; outcome: Outcome; finalizedAtMs: number; startC: number; finalC: number; targetC: number }) => {
  const startedAtMs = p.finalizedAtMs - 8 * HOUR, deadlineAtMs = p.finalizedAtMs - HOUR;
  return { id: p.id, deviceId: p.deviceId, deviceName: p.deviceName, objectiveKind: 'temperature', targetTemperatureC: p.targetC, targetPercent: null, deadlineAtMs, startedAtMs, finalizedAtMs: p.finalizedAtMs, startProgressC: p.startC, startProgressPercent: null, finalProgressC: p.finalC, finalProgressPercent: null, initialEnergyNeededKWh: 4, outcome: p.outcome, metAtMs: p.outcome === 'met' ? deadlineAtMs - HOUR : null, usedDeadlineReserve: false, usedPolicyAvoid: false, observedIntervals: [{ fromMs: startedAtMs, toMs: deadlineAtMs }], discoveredFrom: 'observation', originalPlan: { hours: [{ startsAtMs: startedAtMs, plannedKWh: 1 }], energyNeededKWh: 4, planStatus: 'on_track', revisedAtMs: startedAtMs }, finalPlan: null, revisionCount: 1 };
};
const buildHistory = (nowMs: number) => {
  const c300 = (i: number, o: Outcome, d: number, s: number, f: number) => makeEntry({ id: `c300-${i}`, deviceId: 'dev_connected300', deviceName: 'Connected 300', outcome: o, finalizedAtMs: nowMs - d * DAY, startC: s, finalC: f, targetC: 65 });
  const kontor = (i: number, o: Outcome, d: number, s: number, f: number) => makeEntry({ id: `kontor-${i}`, deviceId: 'dev_termostat_kontor', deviceName: 'Termostat kontor', outcome: o, finalizedAtMs: nowMs - d * DAY, startC: s, finalC: f, targetC: 21 });
  const entries = [kontor(1, 'missed', 1, 17.7, 20.9), kontor(2, 'met', 2, 19, 21), c300(1, 'met', 1, 50, 65), c300(2, 'missed', 3, 50, 58), c300(3, 'abandoned', 4, 50, 52)];
  return { version: 1, entriesByDeviceId: { dev_connected300: entries.filter((e) => e.deviceId === 'dev_connected300'), dev_termostat_kontor: entries.filter((e) => e.deviceId === 'dev_termostat_kontor') } };
};
const seed = (data: { history: unknown }) => {
  (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = { apiHandlers: { 'GET /ui_deferred_objective_history': () => data.history } };
};

const openSmartTasks = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Smart tasks' }).click();
  await expect(page.locator('.deadlines-history__heading')).toBeVisible();
};

test('Homey host stylesheet does not bleed onto native <button> or <label> in dark theme', async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== 'chromium', 'Mobile dark capture needs chromium isMobile emulation.');
  // A manually-created context does NOT inherit the fixture baseURL, so pass it
  // explicitly or `openSmartTasks`'s `page.goto('/')` has no base to resolve
  // against under the dynamic-port e2e server (mirrors smart-tasks-surface).
  const ctx = await browser.newContext({ baseURL, viewport: { width: 480, height: 2400 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(FIXED_NOW_MS);
  await page.addInitScript(seed, { history: buildHistory(FIXED_NOW_MS) });
  await openSmartTasks(page);
  // Reproduce the real iframe: inject the captured Homey host CSS AFTER our sheet.
  // `addStyleTag` resolves once the sheet is applied and `getComputedStyle`
  // below forces a synchronous style recalc, so no settle wait is needed.
  await page.addStyleTag({ content: HOMEY_HOST_CSS });

  const { buttonBleeders, labelBleeders } = await page.evaluate((grey) => {
    const buttons: { cls: string; bg: string }[] = [];
    for (const btn of Array.from(document.querySelectorAll('button'))) {
      // Skip Homey's OWN button classes (intentionally host-styled, not ours).
      // Do NOT skip `hy-nostyle`: those are exactly our opt-out buttons, and the
      // whole point is to confirm the opt-out keeps the host grey OFF them. If a
      // PELS <button> ever loses its hy-nostyle class, the host rule greys it and
      // it shows up here.
      if (/(^| )(homey-button|hy-button)/.test(btn.className)) continue;
      const bg = getComputedStyle(btn).backgroundColor;
      if (bg === grey) buttons.push({ cls: btn.className || '(no class)', bg });
    }
    // Sibling guard for the EXISTING label defence. The host `label:not(.hy-nostyle)`
    // rule force-uppercases bare <label>s, but PELS already neutralises it globally
    // with `label { text-transform: none !important; … }` (style.css:146) — so
    // unlike buttons, labels need no per-element opt-out. This asserts that defence
    // still holds: if the override is ever dropped, the host rule wins and a PELS
    // <label> computes `text-transform: uppercase`, which shows up here. The static
    // field labels live in `.panel hidden` (display:none) sections and Chromium's
    // getComputedStyle does NOT resolve the cascade for display:none subtrees, so
    // un-hide every panel first to make all static labels checkable from any tab.
    for (const panel of Array.from(document.querySelectorAll<HTMLElement>('.panel'))) {
      panel.classList.remove('hidden');
      panel.hidden = false;
    }
    const labels: { cls: string; transform: string }[] = [];
    for (const label of Array.from(document.querySelectorAll('label'))) {
      if (/(^| )(homey-|hy-label)/.test(label.className)) continue;
      const t = getComputedStyle(label).textTransform;
      if (t === 'uppercase') labels.push({ cls: label.className || '(no class)', transform: t });
    }
    return { buttonBleeders: buttons, labelBleeders: labels };
  }, HOST_GREY);

  await ctx.close();
  expect(buttonBleeders, `native <button>s wearing the Homey host grey (${HOST_GREY}) — they need the hy-nostyle class`).toEqual([]);
  expect(labelBleeders, 'native <label>s host-uppercased — the global `label{}!important` override (style.css) was dropped').toEqual([]);
});
