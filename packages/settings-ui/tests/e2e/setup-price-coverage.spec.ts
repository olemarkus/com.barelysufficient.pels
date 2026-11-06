import { expect, renderTest as test, type Page } from './fixtures/test';

const seedKoreanHomeWithoutPrices = async (page: Page) => {
  await page.addInitScript(() => {
    const heater = {
      id: 'setup-heatpump', name: 'Heat pump', zone: 'Hall', available: true,
      deviceClass: 'heater', deviceType: 'temperature', isEvCharger: false,
      isBatteryOrSolar: false, binaryControllable: true, canSetControl: true,
      powerCapable: true, capabilities: ['onoff', 'target_temperature', 'measure_power'],
      targets: [{ name: 'target_temperature', value: 21 }],
      measuredPowerKw: 0, expectedPowerKw: 2, expectedPowerSource: 'measured-peak',
      managed: true,
    };
    (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: [heater],
        managed_devices: { [heater.id]: true }, controllable_devices: { [heater.id]: true },
        price_optimization_settings: {
          [heater.id]: { enabled: true, priceConfigured: true, cheapDelta: 1, expensiveDelta: -1 },
        },
        capacity_enabled: false, capacity_dry_run: true, daily_budget_enabled: false,
        price_scheme: 'homey', homey_prices_today: null, homey_prices_tomorrow: null,
        flow_prices_today: null, flow_prices_tomorrow: null,
        combined_prices: null, task_price_periods: [],
        ui_hub_market_country: 'KR',
        ui_devices_has_managed_solar: false, ui_devices_has_exhibited_export: false,
        ui_devices_surplus_pool_reachable: false,
      },
      priceSetupSuggestion: {
        gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'app_unavailable' },
      },
    };
  });
};

const expectNoSideScroll = async (page: Page) => {
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
};

for (const [width, mobile] of [[320, false], [480, false], [320, true], [480, true]] as const) {
  test.describe(`Korean price setup at ${width}px ${mobile ? 'dark' : 'light'}`, () => {
    test.use({ viewport: { width, height: mobile ? 3200 : 900 }, timezoneId: 'Asia/Seoul',
      isMobile: mobile, hasTouch: mobile });

    test('offers custom prices without claiming an empty Flow completes setup', async ({ page }, testInfo) => {
      await seedKoreanHomeWithoutPrices(page);
      await page.goto('/?page=settings/electricity-prices&setup=prices');
      const panel = page.locator('#electricity-prices-panel');
      const journey = panel.locator('.setup-journey');
      await expect(journey).toContainText('Homey Energy has no prices for your Homey.');
      await expect(journey.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
      await expect(panel).toContainText('Power by the Hour offers European market prices');
      await expect(panel).toContainText('Check that it covers your tariff before adding it.');
      await expect(panel).toContainText('You need to supply the prices for your own contract.');
      await expect(panel).not.toContainText('Otherwise, use Power by the Hour with your tariff.');
      await expect(panel.getByRole('button', { name: 'Use Flow prices', exact: true })).toBeVisible();
      await expectNoSideScroll(page);
      await page.screenshot({ path: testInfo.outputPath('korean-price-guidance.png'), scale: 'css', fullPage: !mobile });

      await panel.getByRole('button', { name: 'Use Flow prices', exact: true }).click();
      await expect(journey).toContainText('Send today’s or tomorrow’s prices through a Flow.');
      await expect(journey.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
      await expect(journey.getByRole('button', { name: 'Review setup', exact: true })).toHaveCount(0);
      await expect(panel).toContainText('No data received');
      await expectNoSideScroll(page);
      await page.screenshot({ path: testInfo.outputPath('flow-prices-still-missing.png'), scale: 'css', fullPage: !mobile });

      await panel.getByRole('button', { name: 'Choose what PELS does', exact: true }).click();
      await expect(page).toHaveURL(/setup=goals/);
      await expect(page.locator('#devices-panel .setup-journey')).toContainText('Choose what PELS does');
      await expect(page.getByRole('switch', { name: 'Price-based control for Heat pump', exact: true })).toBeChecked();
    });
  });
}
