/**
 * Captures Weather insight screenshots for docs/weather-insight.md.
 * Skipped in CI - run locally with:
 *   npx playwright test docs-weather-screenshots.spec.ts --project=chromium-mobile-width
 * Use PELS_E2E_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome if Playwright's
 * bundled Chromium is unavailable on the local platform.
 *
 * Seeds the deterministic weather readout the stub builds for an enabled
 * feature with an outdoor device, then captures the four surfaces the docs
 * page walks: the Budget Tomorrow card, the detail summary, the usage-vs-
 * temperature scatter, and the Settings sub-page.
 */
import { expect, renderTest as test, type Page } from './fixtures/test';

const OUT = '../../docs/screenshots/weather-insight';

test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(Boolean(process.env.CI), 'Docs weather screenshots are for local use only');
  test.skip(
    testInfo.project.name !== 'chromium-mobile-width',
    'Screenshots are pinned to chromium-mobile-width to avoid clobbering.',
  );
});

test.use({ viewport: { width: 480, height: 900 } });

// Weather on with an outdoor device. A generous daily budget makes the stub's
// deterministic verdict the calm one; the daily budget is enabled so the
// suggested-vs-current rows and auto-apply read normally.
const seedWeatherOn = async (page: Page, extra: Record<string, unknown> = {}) => {
  await page.addInitScript((overrides) => {
    (window as Window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        weather_advisor_settings: { enabled: true, outdoorDeviceId: 'dev_outdoor', ...overrides },
        daily_budget_enabled: true,
        daily_budget_kwh: 50,
        // Suppress the one-time "ready" toast so it doesn't overlap the card.
        weather_advisor_first_estimate_seen: true,
      },
    };
  }, extra);
};

const hideGlobalChrome = async (page: Page) => {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
    document.querySelector<HTMLElement>('.hero')?.style.setProperty('display', 'none');
  });
};

const openBudgetTab = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Budget' }).click();
  await expect(page.locator('#budget-panel')).toBeVisible();
  await hideGlobalChrome(page);
};

const shoot = async (page: Page, selector: string, name: string) => {
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await target.screenshot({ path: `${OUT}/${name}.png` });
};

test('budget tomorrow card', async ({ page }) => {
  await seedWeatherOn(page);
  await openBudgetTab(page);
  const card = page.locator('#weather-tomorrow-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Tomorrow: around');
  await expect(card).toContainText('Suggested daily budget');
  await shoot(page, '#weather-tomorrow-card', 'tomorrow-card');
});

test('over-cap warning', async ({ page }) => {
  await seedWeatherOn(page, { cappedByCapacity: true });
  await openBudgetTab(page);
  const card = page.locator('#weather-tomorrow-card');
  await expect(card.locator('#weather-overcap-banner')).toBeVisible();
  await shoot(page, '#weather-tomorrow-card', 'over-cap-warning');
});

test('detail summary and numbers', async ({ page }) => {
  await seedWeatherOn(page);
  await openBudgetTab(page);
  await page.locator('#weather-tomorrow-card #weather-details-button').click();
  await expect(page.locator('#weather-insight-view')).toBeVisible();
  await expect(page.locator('#weather-summary-card')).toBeVisible();
  await shoot(page, '#weather-summary-card', 'home-summary');
  await shoot(page, '#weather-numbers-card', 'home-in-numbers');
});

test('usage vs temperature scatter', async ({ page }) => {
  await seedWeatherOn(page);
  await openBudgetTab(page);
  await page.locator('#weather-tomorrow-card #weather-details-button').click();
  const scatter = page.locator('#weather-scatter-card');
  await expect(scatter).toBeVisible();
  // ECharts SVG renderer: wait for it to mount real content before shooting.
  const svg = scatter.locator('#weather-insight-chart svg');
  await expect(svg).toBeVisible();
  await expect.poll(() => svg.evaluate((el) => el.childElementCount)).toBeGreaterThan(0);
  await expect(scatter.locator('#weather-coverage-band')).toBeVisible();
  await page.waitForTimeout(500);
  await shoot(page, '#weather-scatter-card', 'usage-vs-temperature');
});

test('settings sub-page enabled', async ({ page }) => {
  await seedWeatherOn(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('#weather-insight-nav-card').click();
  await expect(page.locator('#weather-panel')).toBeVisible();
  await expect(page.locator('#weather-insight-settings')).toBeVisible();
  await expect(page.locator('#weather-outdoor-select')).toBeVisible();
  await expect(page.locator('#weather-enable-switch')).toBeVisible();
  await expect(page.locator('#weather-auto-apply-switch')).toBeVisible();
  await hideGlobalChrome(page);
  await shoot(page, '#weather-panel', 'settings');
});
