/**
 * Weather insight surface (Budget tab + Settings sub-page).
 *
 * Off is the load-bearing case: with `weather_advisor_settings` absent the
 * Budget page carries ZERO weather DOM (structural absence, not CSS hiding) —
 * but the Settings sub-page is now always reachable and shows the master
 * on/off switch (off), with no device pickers until it is turned on. Runs in
 * every Playwright project, so this is asserted at 480 px (chromium + firefox)
 * AND 320 px (chromium-narrow).
 *
 * On drives the real navigation loop: Tomorrow card → `Weather details`
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

// Reads the persisted weather_advisor_settings.enabled straight from the Homey
// stub, so a toggle's persistence (not just its optimistic render) is asserted.
const readPersistedEnabled = (page: Page): Promise<boolean | undefined> => page.evaluate(() => (
  new Promise<boolean | undefined>((resolve) => {
    (window as unknown as { Homey: { get: (k: string, cb: (e: unknown, v: unknown) => void) => void } })
      .Homey.get('weather_advisor_settings', (_error, value) => {
        resolve((value as { enabled?: boolean } | undefined)?.enabled);
      });
  })
));

const readPersistedAutoApply = (page: Page): Promise<boolean | undefined> => page.evaluate(() => (
  new Promise<boolean | undefined>((resolve) => {
    (window as unknown as { Homey: { get: (k: string, cb: (e: unknown, v: unknown) => void) => void } })
      .Homey.get('weather_advisor_settings', (_error, value) => {
        resolve((value as { autoApplyDailyBudget?: boolean } | undefined)?.autoApplyDailyBudget);
      });
  })
));

test.describe('Weather insight', () => {
  test('off: no weather card on Budget; sub-page shows the master switch, no pickers', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openBudgetTab(page);
    // The Budget surface itself rendered…
    await expect(page.locator('#budget-plan-summary')).toBeVisible();
    // …but no weather card exists on the Budget page while the feature is off.
    await expect(page.locator('#budget-panel [id^="weather-"]')).toHaveCount(0);
    await expect(page.locator('#budget-panel [class*="weather-"]')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    // The nav card is now always visible — the entry point to turn the feature on.
    const navCard = page.locator('#weather-insight-nav-card');
    await expect(navCard).toBeVisible();
    await navCard.click();
    await expect(page.locator('#weather-panel')).toBeVisible();
    // Master switch present; no device pickers until it is enabled.
    await expect(page.locator('#weather-enable-switch')).toBeVisible();
    await expect(page.locator('#weather-insight-settings')).toHaveCount(0);
    // The Budget cross-link promises an outlook that doesn't exist while off.
    await expect(page.locator('#weather-see-in-budget')).toBeHidden();
  });

  test('off → enabling from the master switch reveals the device pickers and persists', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#weather-insight-nav-card').click();
    await expect(page.locator('#weather-panel')).toBeVisible();
    await expect(page.locator('#weather-insight-settings')).toHaveCount(0);
    // Turn the feature on from its master switch → the pickers appear and the
    // cross-link is revealed; the flag is persisted (not just optimistically shown).
    await page.locator('#weather-enable-switch').click();
    await expect(page.locator('#weather-insight-settings')).toBeVisible();
    await expect(page.locator('#weather-outdoor-select')).toBeVisible();
    await expect(page.locator('#weather-see-in-budget')).toBeVisible();
    expect(await readPersistedEnabled(page)).toBe(true);
  });

  test('on → disabling keeps the user on the sub-page and persists off', async ({ page }) => {
    await enableWeatherFlag(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#weather-insight-nav-card').click();
    await expect(page.locator('#weather-panel')).toBeVisible();
    await expect(page.locator('#weather-insight-settings')).toBeVisible();
    // Toggle off from the master switch: the sub-page stays open (the switch lives
    // here), the pickers + cross-link disappear, and the flag persists off.
    await page.locator('#weather-enable-switch').click();
    await expect(page.locator('#weather-panel')).toBeVisible();
    await expect(page.locator('#weather-enable-switch')).toBeVisible();
    await expect(page.locator('#weather-insight-settings')).toHaveCount(0);
    await expect(page.locator('#weather-see-in-budget')).toBeHidden();
    expect(await readPersistedEnabled(page)).toBe(false);
  });

  test('on: the over-hard-cap warning banner shows when the suggestion is capacity-capped', async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          weather_advisor_settings: {
            enabled: true, outdoorDeviceId: 'dev_outdoor', forecastDeviceId: 'dev_forecast', cappedByCapacity: true,
          },
          daily_budget_enabled: true,
          daily_budget_kwh: 50,
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openBudgetTab(page);
    const banner = page.locator('#weather-tomorrow-card #weather-overcap-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('hard cap');
  });

  test('on: Tomorrow card → Weather details → chart → Done loop', async ({ page }) => {
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

  test('on: the auto-apply toggle persists and warns while the daily budget is off', async ({ page }) => {
    // Weather on, daily budget explicitly OFF (the stub base defaults it on).
    await page.addInitScript(() => {
      (window as Window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          weather_advisor_settings: { enabled: true, outdoorDeviceId: 'dev_outdoor', forecastDeviceId: 'dev_forecast' },
          daily_budget_enabled: false,
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#weather-insight-nav-card').click();
    await expect(page.locator('#weather-panel')).toBeVisible();
    const sw = page.locator('#weather-auto-apply-switch');
    await expect(sw).toBeVisible();
    await expect(page.locator('#weather-auto-apply-needs-budget')).toHaveCount(0);
    await sw.click();
    // Auto-apply on while the daily budget is off → the inert hint appears, and the flag persists.
    await expect(page.locator('#weather-auto-apply-needs-budget')).toBeVisible();
    await expect.poll(() => readPersistedAutoApply(page)).toBe(true);
  });

  test('on: nav card opens the Weather insight sub-page with the two pickers', async ({ page }) => {
    await enableWeatherFlag(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    // The nav card opens the dedicated sub-page; with the feature on the pickers render.
    const navCard = page.locator('#weather-insight-nav-card');
    await expect(navCard).toBeVisible();
    await navCard.click();
    await expect(page.locator('#weather-panel')).toBeVisible();
    const section = page.locator('#weather-insight-settings');
    await expect(section).toBeVisible();
    await expect(section.locator('#weather-outdoor-select')).toBeVisible();
    await expect(section.locator('#weather-forecast-select')).toBeVisible();
    // The cross-link back to the Budget payoff is present.
    await expect(page.locator('#weather-see-in-budget')).toBeVisible();
  });

  test('on, no device: Budget setup card deep-links to the Weather sub-page', async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        // Feature on but no outdoor device → Budget shows the setup card (needs_device).
        settings: { weather_advisor_settings: { enabled: true }, daily_budget_kwh: 50 },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openBudgetTab(page);
    const setup = page.locator('#weather-setup-card');
    await expect(setup).toBeVisible();
    await setup.locator('#weather-setup-pick-device').click();
    await expect(page.locator('#weather-panel')).toBeVisible();
    await expect(page.locator('#weather-insight-settings')).toBeVisible();
  });
});
