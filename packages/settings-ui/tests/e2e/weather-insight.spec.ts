/**
 * Hidden Weather insight surface (Budget tab + Settings pickers).
 *
 * Flag-off is the load-bearing case: `weather_advisor_settings` absent must
 * leave ZERO weather DOM ids on the Budget page and an empty Settings mount —
 * structural absence, not CSS hiding. Runs in every Playwright project, so
 * the absence is asserted at 480 px (chromium + firefox) AND 320 px
 * (chromium-narrow).
 *
 * Flag-on drives the real navigation loop: Tomorrow card → `Weather details`
 * → detail view (header `Weather insight`, scatter chart with a non-empty
 * SVG) → `Done` → back to the plan view.
 */
import { expect, test, type Page } from './fixtures/test';

const enableWeatherFlag = async (page: Page) => {
  await page.addInitScript(() => {
    (window as Window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        weather_advisor_settings: {
          enabled: true,
          outdoorDeviceId: 'dev_outdoor',
          forecastDeviceId: 'dev_forecast',
        },
        // Generous budget so the stub's deterministic verdict is the calm one.
        daily_budget_kwh: 50,
      },
    };
  });
};

const openBudgetTab = async (page: Page) => {
  await page.getByRole('tab', { name: 'Budget' }).click();
  await expect(page.locator('#budget-panel')).toBeVisible();
};

test.describe('Weather insight (hidden flag)', () => {
  test('flag off: no weather DOM on Budget, Settings mount stays empty', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openBudgetTab(page);
    // The Budget surface itself rendered…
    await expect(page.locator('#budget-plan-summary')).toBeVisible();
    // …but nothing weather-shaped exists anywhere in the panel.
    await expect(page.locator('#budget-panel [id^="weather-"]')).toHaveCount(0);
    await expect(page.locator('[class*="weather-"]')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    await expect(page.locator('#weather-insight-settings-mount')).toBeEmpty();
  });

  test('flag on: Tomorrow card → Weather details → chart → Done loop', async ({ page }) => {
    await enableWeatherFlag(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openBudgetTab(page);

    const card = page.locator('#weather-tomorrow-card');
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText('Tomorrow: around');
    await expect(card).toContainText('Suggested daily budget');

    await card.locator('#weather-details-button').click();
    const detail = page.locator('#weather-insight-view');
    await expect(detail).toBeVisible();
    await expect(page.locator('#budget-panel .plan-hero__headline')).toHaveText('Weather insight');
    await expect(detail.locator('#weather-summary-card')).toBeVisible();
    await expect(detail.locator('#weather-numbers-card')).toBeVisible();

    // The scatter chart mounted with real SVG content (ECharts SVG renderer).
    const svg = detail.locator('#weather-insight-chart svg');
    await expect(svg).toBeVisible();
    expect(await svg.evaluate((element) => element.childElementCount)).toBeGreaterThan(0);
    await expect(detail.locator('#weather-coverage-band')).toBeVisible();

    await page.locator('#budget-redesign-mode-toggle').click();
    await expect(page.locator('#weather-insight-view')).toHaveCount(0);
    await expect(card).toBeVisible();
  });

  test('flag on: Settings section renders the two native device pickers', async ({ page }) => {
    await enableWeatherFlag(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    const section = page.locator('#weather-insight-settings');
    await expect(section).toBeVisible();
    await expect(section.locator('#weather-outdoor-select')).toBeVisible();
    await expect(section.locator('#weather-forecast-select')).toBeVisible();
  });
});
