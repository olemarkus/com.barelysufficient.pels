import {
  expect, injectHomeyHostCss, loadSpaceGrotesk, renderTest as test, type Page,
} from './fixtures/test';

const seedRelay = async (page: Page, measurement: 'live' | 'derived' | 'missing') => {
  await page.addInitScript((powerMeasurement) => {
    (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: [{
          id: 'relay-heater', name: 'Water heater', available: true,
          deviceClass: 'socket', deviceType: 'onoff', binaryControllable: true,
          isEvCharger: false, isBatteryOrSolar: false, managed: true,
          powerCapable: true, capabilities: ['onoff', 'measure_power'], targets: [],
          expectedPowerKw: 2, expectedPowerSource: 'measured-peak',
          ...(powerMeasurement === 'missing' ? {} : {
            measuredPowerKw: 0,
            measuredPowerIsDirectMeasurement: powerMeasurement === 'live',
          }),
        }],
        managed_devices: { 'relay-heater': true },
        controllable_devices: { 'relay-heater': false },
        price_optimization_settings: {}, daily_budget_enabled: false,
        ui_devices_has_managed_solar: false,
        ui_devices_has_exhibited_export: false,
        ui_devices_surplus_pool_reachable: false,
      },
      unsetSettings: ['deferred_objective.dev_connected300'],
    };
  }, measurement);
  await page.goto('/?page=settings/recommendations');
};

test('relay energy task discovery opens settings and keeps its existing dismissal', async ({
  page, browser, browserName, baseURL,
}, testInfo) => {
  await seedRelay(page, 'live');
  const active = page.locator('#setup-recommendations-root [aria-label="Recommendations to review"]');
  const hint = active.locator('.setup-recommendation-card', { hasText: 'Choose what PELS does' });
  await expect(hint).toBeVisible();
  await expect(hint.locator('.plan-chip')).toHaveText('Optional');
  await expect(hint).toContainText('PELS can have something ready by a set time.');
  const guide = hint.getByRole('link', { name: 'Heat a water heater overnight' });
  await expect(guide).toHaveAttribute('href',
    'https://pels.barelysufficient.org/smart-tasks#heat-a-water-heater-on-a-relay-overnight');
  await expect(guide).toHaveAttribute('target', '_blank');
  await expect(hint.getByText('Dismiss', { exact: true })).toBeVisible();
  await loadSpaceGrotesk(page);

  for (const width of [480, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(guide).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`relay-discovery-${width}.png`), fullPage: true });
  }

  await hint.getByText('Dismiss', { exact: true }).click();
  await expect(hint).toHaveCount(0);
  const dismissed = page.locator('#setup-recommendations-root .setup-recommendations-dismissed');
  await dismissed.locator('summary').click();
  await expect(dismissed.getByRole('link', { name: 'Heat a water heater overnight' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { Homey: { __stub: { getSetting: (key: string) => unknown } } }
  ).Homey.__stub.getSetting('setup_recommendation_dismissals'))).toEqual({ 'after-setup:goals': 1 });
  await dismissed.getByText('Show again', { exact: true }).click();
  await expect(hint).toBeVisible();
  await hint.getByText('Choose', { exact: true }).click();
  await expect(page).toHaveURL(/setup=goals/);
  await expect(page.locator('#device-card-list [data-device-id="relay-heater"]')).toContainText('New smart task');

  if (browserName === 'chromium') {
    const context = await browser.newContext({
      baseURL, viewport: { width: 320, height: 1000 }, isMobile: true, hasTouch: true,
    });
    try {
      const mobile = await context.newPage();
      await injectHomeyHostCss(mobile);
      await seedRelay(mobile, 'live');
      await loadSpaceGrotesk(mobile);
      await expect(mobile.getByText('Dismiss', { exact: true })).toBeVisible();
      await expect(mobile.getByRole('link', { name: 'Heat a water heater overnight' })).toBeInViewport();
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await mobile.screenshot({ path: testInfo.outputPath('relay-discovery-320-dark.png') });
    } finally {
      await context.close();
    }
  }
});

for (const measurement of ['derived', 'missing'] as const) {
  test(`relay energy task discovery stays hidden for ${measurement} power`, async ({ page }) => {
    await seedRelay(page, measurement);
    await expect(page.locator('#setup-recommendations-root')).toContainText('No setup suggestions right now');
    await expect(page.getByText('Choose what PELS does', { exact: true })).toHaveCount(0);
  });
}
