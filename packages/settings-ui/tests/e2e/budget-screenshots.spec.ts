import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, renderTest as test, type Page } from './fixtures/test';

// Regenerate the Budget-page figures embedded in docs/daily-budget.md:
//   PELS_CAPTURE_SCREENSHOTS=1 npx playwright test budget-screenshots \
//     --project=chromium-mobile-width
// The capture is pinned to the 480 px mobile width (the documented doc-shot
// resolution) and drives the same stub the other settings-UI specs use, so the
// figures stay faithful to what users see on-device.

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(SCRIPT_DIR, '../../../../docs/screenshots/daily-budget');

// Pin the clock so the stub's `buildSampleDailyBudgetPayload` (which derives the
// current hour, used/remaining kWh, and chart actuals from `Date.now()`) renders
// the same "a little after 11:00 on a 12 kWh day" the docs describe, every time
// the capture is re-run. Without this, regenerating would overwrite the
// committed figures with whatever the wall clock happened to be.
const CAPTURE_TIME = new Date('2026-01-15T11:13:00Z');

// Seed a budget at the configurable minimum (MIN_DAILY_BUDGET_KWH = 20). The
// stub's default sample is 12 kWh, which production clamps away — an enabled
// budget below 20 is not a state a user can actually configure — so capturing it
// would document an unreachable Budget page. 20 kWh is reachable and matches the
// 20–360 kWh range the same doc states.
const CAPTURE_BUDGET_KWH = 20;

const openBudgetPlan = async (page: Page) => {
  await page.clock.setFixedTime(CAPTURE_TIME);
  await page.addInitScript((budgetKWh) => {
    const existing = (window as unknown as { __PELS_HOMEY_STUB__?: Record<string, unknown> }).__PELS_HOMEY_STUB__ ?? {};
    const existingSettings = (existing.settings as Record<string, unknown> | undefined) ?? {};
    (window as unknown as { __PELS_HOMEY_STUB__?: Record<string, unknown> }).__PELS_HOMEY_STUB__ = {
      ...existing,
      settings: { ...existingSettings, daily_budget_kwh: budgetKWh },
    };
  }, CAPTURE_BUDGET_KWH);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.getByRole('tab', { name: 'Budget' }).click();
  await expect(page.locator('#budget-panel')).toBeVisible();
  await expect(page.locator('#budget-redesign-surface')).toBeVisible();
  await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();
  // The SVG mounts before ECharts paints the first frame; poll until the chart
  // carries rendered label text (same idiom as deadline-plan-screenshots.spec)
  // so the capture never races the paint and commits a blank/partial chart.
  await page.waitForFunction(() => (
    (document.querySelector('#budget-redesign-chart svg')?.textContent ?? '').length > 0
  ));
  // The global dry-run banner is host chrome, not part of the Budget surface;
  // hide it for a clean doc capture. Keep the tablist and the budget hero —
  // they are the context the walkthrough refers to.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
  });
};

test.describe('Daily budget screenshots', () => {
  test.skip(process.env.PELS_CAPTURE_SCREENSHOTS !== '1', 'Set PELS_CAPTURE_SCREENSHOTS=1 to regenerate.');
  test.use({ viewport: { width: 480, height: 900 } });

  test('captures the Plan view (Progress) at 480px', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-mobile-width',
      'Doc capture is pinned to chromium-mobile-width.',
    );
    await openBudgetPlan(page);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'plan-progress.png'), fullPage: true });
  });

  test('captures the Plan view (Hourly plan) at 480px', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-mobile-width',
      'Doc capture is pinned to chromium-mobile-width.',
    );
    await openBudgetPlan(page);
    // The pre-click readiness check already left non-empty SVG text from the
    // Progress chart, so a generic "text is non-empty" wait would resolve before
    // the view switches. Snapshot the current text and wait for it to CHANGE, so
    // the capture is the Hourly-plan chart and not a transitional render.
    const progressText = await page.evaluate(() => (
      document.querySelector('#budget-redesign-chart svg')?.textContent ?? ''
    ));
    await page.getByRole('button', { name: 'Hourly plan', exact: true }).click();
    await page.waitForFunction((previous) => {
      const current = document.querySelector('#budget-redesign-chart svg')?.textContent ?? '';
      return current.length > 0 && current !== previous;
    }, progressText);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'hourly-plan.png'), fullPage: true });
  });
});
