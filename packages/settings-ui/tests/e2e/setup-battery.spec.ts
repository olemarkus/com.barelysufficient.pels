import { expect, renderTest as test, type Page } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';

// A Dutch P1 + solar + home battery home with no limit to hold: the battery is
// managed by its own setting (`battery_control_devices`, absent = on) and is
// the only device setup has, so it alone must finish the Devices step, and
// `Choose what PELS does` offers its plan.
const SCREENSHOT_DIR = process.env.PELS_SETUP_BATTERY_SCREENSHOT_DIR;

const seedBatteryHome = async (page: Page, { hasPrices = true, hasCharger = false, checkEligibility = false } = {}) => {
  await page.addInitScript(({ hasPrices, hasCharger, checkEligibility }) => {
    let keyConfigured = false;
    const battery = {
      id: 'setup-battery', name: 'Thuisbatterij', zone: 'Garage', available: true,
      deviceClass: 'battery', deviceType: 'onoff', isEvCharger: false, isBatteryOrSolar: true,
      batteryControl: 'drivable', batteryTakenOver: false, batteryUsesHomeyApiKey: false,
      canSetControl: true, powerCapable: true, capabilities: ['measure_power', 'measure_battery'], targets: [],
      measuredPowerKw: 0, expectedPowerKw: 2.5, expectedPowerSource: 'default',
    };
    const additionalBatteries = checkEligibility ? [{
      ...battery, id: 'cloud-battery', name: 'Cloud battery', batteryControl: 'controlled_through_local_device',
      managed: true, binaryControllable: false,
    }, {
      ...battery, id: 'observe-battery', name: 'Observe-only battery', batteryControl: 'observe_only',
      managed: true, binaryControllable: false,
    }] : [];
    const charger = {
      id: 'optional-ev', name: 'Optional EV', deviceClass: 'evcharger', deviceType: 'onoff',
      isEvCharger: true, isBatteryOrSolar: false, available: true, powerCapable: true, canSetControl: true,
      measuredPowerKw: 0, targets: [], capabilities: ['onoff', 'evcharger_charging', 'measure_power'],
      managed: false, binaryControllable: true, controlModel: 'binary_power',
    };
    const w = window as unknown as {
      __PELS_HOMEY_STUB__: unknown;
      Homey: { __stub: { getSetting: (key: string) => unknown } };
    };
    const planRead = () => {
      const configs = (w.Homey.__stub.getSetting('continuous_battery_plan') ?? {}) as Record<string, { enabled: boolean }>;
      const config = configs[battery.id] ?? {
        enabled: false, usableCapacityKWh: 10, minimumReservePercent: 20, roundTripEfficiency: 0.9,
        wearCostPerKWh: 0.03, priceUnit: 'price units', exportPolicy: { kind: 'household_only' },
      };
      return { status: 'disabled', config: { ...config, enabled: false } };
    };
    w.__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: hasCharger ? [battery, charger] : [battery], managed_devices: {}, controllable_devices: {},
        battery_control_devices: {}, continuous_battery_plan: {},
        price_optimization_settings: {}, capacity_dry_run: sessionStorage.getItem('saved-dry-run') !== 'false',
        capacity_enabled: false,
        daily_budget_enabled: false, ui_hub_market_country: 'NL',
        ui_devices_has_managed_solar: true, ui_devices_has_exhibited_export: true,
        ui_devices_surplus_pool_reachable: true,
      },
      continuousBatteryPlans: () => ({ [battery.id]: planRead() }),
      apiHandlers: {
        'GET /ui_devices': () => ({
          devices: [{
            ...battery,
            managed: true,
            binaryControllable: false,
            batteryUsesHomeyApiKey: checkEligibility,
            batteryControl: checkEligibility && !keyConfigured ? 'needs_homey_api_key' : 'drivable',
          }, ...additionalBatteries, ...(hasCharger ? [charger] : [])],
          inverterDevices: [],
          continuousBatteryPlans: { [battery.id]: planRead() },
          chargerPhasePresets: { state: 'resolved', presets: {} },
          hasManagedSolarDevice: true, hasExhibitedExport: true, surplusPoolReachable: true,
        }),
        'GET /ui_charging_access': () => ({ configured: keyConfigured, state: keyConfigured ? 'ready' : 'not_configured' }),
        'PUT /ui_charging_access': () => {
          keyConfigured = true;
          return { configured: true, state: 'ready' };
        },
        'GET /ui_prices': () => ({
          combinedPrices: { priceUnit: 'EUR/kWh' },
          priceTimeline: hasPrices
            ? { state: 'ready', priceUnit: 'EUR/kWh' }
            : { state: 'unavailable', reason: 'no_prices' },
        }),
      },
    };
  }, { hasPrices, hasCharger, checkEligibility });
};

const stored = (page: Page, key: string) => page.evaluate((key) => (
  window as unknown as { Homey: { __stub: { getSetting: (key: string) => unknown } } }
).Homey.__stub.getSetting(key), key);

const expectNoSideScroll = async (page: Page) => {
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
};

const shoot = async (page: Page, width: number, name: string) => {
  if (!SCREENSHOT_DIR || width !== 360) return;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}-${width}.png`, scale: 'css', fullPage: true });
};

for (const width of [320, 360, 480]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 1600 } });

    test('a managed home battery alone finishes the Devices step', async ({ page }) => {
      await seedBatteryHome(page);
      await page.goto('/?page=settings/devices&setup=devices');
      const header = page.locator('#devices-panel .setup-journey');
      await expect(page.getByRole('switch', { name: 'Manage Thuisbatterij', exact: true })).toBeChecked();
      await expect(header.getByRole('button', { name: /^(Continue|Review setup)$/ })).toBeEnabled();
      // No limit is in force, so the battery's hint names the solar job only.
      await expect(page.locator('#device-card-list')).toContainText('PELS controls charging to store spare solar in priority order.');
      await expectNoSideScroll(page);
      await shoot(page, width, 'devices-step-battery-only');
    });

    test('Choose what PELS does offers the battery plan once its usable capacity is entered', async ({ page }) => {
      await seedBatteryHome(page);
      await page.goto('/?page=settings/devices&setup=goals');
      const card = page.locator('#device-card-list [data-device-id="setup-battery"]');
      const toggle = card.getByRole('switch', { name: 'Plan charging with PELS for Thuisbatterij', exact: true });
      await expect(card).toContainText('PELS plans charging and household supply');
      // Never saved: no capacity is assumed, so the switch waits for one.
      await expect(card.locator('md-filled-text-field')).toHaveJSProperty('value', '');
      await expect(toggle).toBeDisabled();
      await expectNoSideScroll(page);
      await shoot(page, width, 'setup-battery-row');

      await setMdValue(page, '#device-card-list [data-device-id="setup-battery"] md-filled-text-field', '5.12');
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect.poll(async () => (await stored(page, 'continuous_battery_plan') as Record<string, unknown>)['setup-battery'])
        .toMatchObject({ enabled: true, usableCapacityKWh: 5.12, priceUnit: 'EUR/kWh', wearCostPerKWh: 0 });
      await expect(card).toContainText('Planned for 5.12 kWh usable capacity. The plan runs once you start managing.');
      await shoot(page, width, 'setup-battery-row-on');

      await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Review setup', exact: true }).click();
      await expect(page.locator('#setup-review-root')).toContainText('Plan charging with PELS on');
      await expectNoSideScroll(page);
    });
  });
}

for (const width of [320, 480]) {
  test(`battery eligibility and key setup at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await seedBatteryHome(page, { checkEligibility: true });
    await page.goto('/?page=settings/devices&setup=devices');
    const header = page.locator('#devices-panel .setup-journey');
    await header.getByRole('button', { name: 'Review battery setup', exact: true }).click();
    const card = page.locator('#device-card-list [data-device-id="setup-battery"]');
    await expect(card).toContainText('Add a Homey API key with Flow permission');
    await expect(card.getByRole('switch')).toHaveCount(0);
    const deviceList = page.locator('#device-card-list');
    await expect(deviceList.locator('[data-device-id="cloud-battery"]')).toContainText('local network device');
    await expect(deviceList.locator('[data-device-id="observe-battery"]')).toContainText('PELS can only observe this battery.');
    await expectNoSideScroll(page);
    await page.screenshot({ path: testInfo.outputPath('battery-eligibility.png'), scale: 'css', fullPage: true });
    await card.getByRole('button', { name: 'Device settings for Thuisbatterij' }).click();
    const key = page.locator('#device-detail-battery-api-key');
    await expect(key).toBeVisible();
    await setMdValue(page, '#device-detail-battery-api-key md-filled-text-field', 'fixture-key');
    await key.getByRole('button', { name: 'Save key' }).click();
    await expect(key).toContainText('Manage API key');
    await page.getByRole('button', { name: 'Close device details' }).click();
    await expect(card).toContainText('Ready to configure');
    await expect(card.getByRole('switch', { name: 'Plan charging with PELS for Thuisbatterij' })).toBeVisible();
    await expectNoSideScroll(page);
    await page.screenshot({ path: testInfo.outputPath('battery-ready.png'), scale: 'css', fullPage: true });
  });
}

for (const width of [320, 480]) {
  test.describe(`missing prices at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('failed battery setup restores the switch and offers price setup', async ({ page }, testInfo) => {
      await seedBatteryHome(page, { hasPrices: false });
      await page.goto('/?page=settings/devices&setup=goals');
      const card = page.locator('#device-card-list [data-device-id="setup-battery"]');
      const toggle = card.getByRole('switch', { name: 'Plan charging with PELS for Thuisbatterij', exact: true });
      await setMdValue(page, '#device-card-list [data-device-id="setup-battery"] md-filled-text-field', '10');
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(card.getByRole('alert')).toContainText('Waiting for electricity prices');
      expect(await stored(page, 'continuous_battery_plan')).toEqual({});
      await expectNoSideScroll(page);
      await page.screenshot({ path: testInfo.outputPath('battery-prices-missing.png'), scale: 'css', fullPage: true });
      await card.getByRole('button', { name: 'Electricity prices', exact: true }).click();
      await expect(page).toHaveURL(/setup=prices/);
      await expect(page.locator('#electricity-prices-panel')).toBeVisible();
    });
  });
}

test('a battery home can leave its charger unmanaged through review, activation and reload', async ({ page }) => {
  await seedBatteryHome(page, { hasCharger: true });
  await page.goto('/?page=settings/devices&setup=devices');
  const header = page.locator('#devices-panel .setup-journey');
  const charger = page.getByRole('switch', { name: 'Manage Optional EV', exact: true });
  await expect(charger).toBeEnabled();
  await expect(charger).not.toBeChecked();
  await expect(header).toContainText('You can also choose an EV charger.');
  await expect(page.getByRole('switch', { name: 'Manage Thuisbatterij', exact: true })).toBeChecked();
  await header.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/setup=hardCap/);
  const limitsHeader = page.locator('#limits-panel .setup-journey');
  await expect(limitsHeader).toContainText('Optional. Set your main fuse to protect each phase.');
  await limitsHeader.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/setup=goals/);
  await header.getByRole('button', { name: 'Review setup', exact: true }).click();
  const review = page.locator('#setup-review-root');
  await expect(review).toContainText('Thuisbatterij');
  await expect(review.locator('[data-device-id="optional-ev"]')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Choose an EV charger (optional)' })).toBeVisible();
  await review.getByRole('button', { name: 'Start managing' }).click();
  await expect.poll(() => stored(page, 'capacity_dry_run')).toBe(false);
  expect(await stored(page, 'managed_devices')).toEqual({});
  // Homey keeps the saved switch when the WebView reopens.
  const savedDryRun = await stored(page, 'capacity_dry_run');
  await page.evaluate((value) => sessionStorage.setItem('saved-dry-run', String(value)), savedDryRun);
  await page.goto('/?page=settings/setup-review&setup=review');
  await expect(review).toContainText('Simulation mode is off');
  await expect(review.getByRole('button', { name: 'Continue setup' })).toHaveCount(0);
  await review.getByRole('button', { name: 'Open Overview' }).click();
  await expect(page.locator('#overview-panel')).toBeVisible();
  await expect(page.locator('#overview-setup-path')).toHaveCount(0);
  await expect(page.locator('#dry-run-banner')).toBeHidden();
});
