import { expect, renderTest as test, type Page } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';

// A Dutch P1 + solar + home battery home with no limit to hold: the battery is
// managed by its own setting (`battery_control_devices`, absent = on) and is
// the only device setup has, so it alone must finish the Devices step, and
// `Choose what PELS does` offers its plan.
const SCREENSHOT_DIR = process.env.PELS_SETUP_BATTERY_SCREENSHOT_DIR;

const seedBatteryHome = async (page: Page) => {
  await page.addInitScript(() => {
    const battery = {
      id: 'setup-battery', name: 'Thuisbatterij', zone: 'Garage', available: true,
      deviceClass: 'battery', deviceType: 'onoff', isEvCharger: false, isBatteryOrSolar: true,
      batteryControl: 'drivable', batteryTakenOver: false, batteryUsesHomeyApiKey: false,
      canSetControl: true, powerCapable: true, capabilities: ['measure_power', 'measure_battery'], targets: [],
      measuredPowerKw: 0, expectedPowerKw: 2.5, expectedPowerSource: 'default',
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
        target_devices_snapshot: [battery], managed_devices: {}, controllable_devices: {},
        battery_control_devices: {}, continuous_battery_plan: {},
        price_optimization_settings: {}, capacity_dry_run: true, capacity_enabled: false,
        daily_budget_enabled: false, ui_hub_market_country: 'NL',
        ui_devices_has_managed_solar: true, ui_devices_has_exhibited_export: true,
        ui_devices_surplus_pool_reachable: true,
      },
      continuousBatteryPlans: () => ({ [battery.id]: planRead() }),
      apiHandlers: {
        'GET /ui_prices': () => ({ combinedPrices: { priceUnit: 'EUR/kWh' }, priceTimeline: { state: 'ready', priceUnit: 'EUR/kWh' } }),
      },
    };
  });
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
      await expect(page.locator('#device-card-list')).toContainText('PELS shares spare solar between it and your devices');
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
