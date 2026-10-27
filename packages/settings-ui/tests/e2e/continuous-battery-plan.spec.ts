import { expect, renderTest as test } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';

for (const width of [320, 480]) {
  for (const mobile of [false, true]) {
    test.describe(`${width}px ${mobile ? 'dark' : 'light'}`, () => {
      test.use({ viewport: { width, height: 2400 }, isMobile: mobile, hasTouch: mobile });
      test.skip(({ browserName }) => mobile && browserName === 'firefox', 'Mobile host emulation uses Chromium');

      test('shows a real plan and saves a reserve without changing battery control permissions', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
          let config = { enabled: true, usableCapacityKWh: 10, minimumReservePercent: 20, roundTripEfficiency: 0.9, wearCostPerKWh: 0.03, priceUnit: 'EUR' };
          const startsAtMs = Date.parse('2026-10-27T01:00:00Z');
          const battery = { id: 'battery-plan-test', name: 'Sessy battery', available: true,
            deviceClass: 'battery', isBatteryOrSolar: true, batteryControl: 'drivable', batteryTakenOver: false,
            capabilities: ['measure_power', 'measure_battery'], targets: [], canSetControl: true,
            powerCapable: true, expectedPowerKw: 2.5, expectedPowerSource: 'default' };
          const read = () => {
            if (!config.enabled) return { status: 'disabled', config };
            const terminal = Math.max(3, config.usableCapacityKWh * config.minimumReservePercent / 100);
            const common = { durationMs: 3_600_000, gridExportKWh: 0, exportRevenue: 0, wearCost: 0 };
            return { status: 'planned', config, generatedAtMs: startsAtMs, priceUnit: 'EUR', plan: {
              status: 'planned', periods: [
                { ...common, startsAtMs, batteryPowerKW: 2, energyBeforeKWh: 4, energyAfterKWh: 6,
                  gridImportKWh: 3.2, importCost: 0.32, reason: 'charge_grid' },
                { ...common, startsAtMs: startsAtMs + 3_600_000, batteryPowerKW: 0, energyBeforeKWh: 6, energyAfterKWh: 6,
                  gridImportKWh: 1, importCost: 0.2, reason: 'hold_energy' },
                { ...common, startsAtMs: startsAtMs + 7_200_000, batteryPowerKW: terminal - 6, energyBeforeKWh: 6, energyAfterKWh: terminal,
                  gridImportKWh: 0.5, importCost: 0.18, reason: 'supply_house' },
              ], importCost: 0.7, exportRevenue: 0, wearCost: 0, energyCost: 0.7, terminalEnergyValue: 0,
              objectiveCost: 0.7, terminalEnergyKWh: terminal, resolutionKWh: 0.05,
            } };
          };
          (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
            settings: {
              target_devices_snapshot: [battery], battery_control_devices: {},
              controllable_devices: { [battery.id]: true }, capacity_dry_run: false,
            },
            apiHandlers: {
              'GET /ui_battery_plan/battery-plan-test': read,
              'PUT /ui_battery_plan/battery-plan-test': (body: typeof config) => { config = body; return config; },
            },
          };
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
        await page.locator('#devices-panel [data-device-id="battery-plan-test"] .pels-device-card__detail-button').first().click();
        const section = page.locator('#device-detail-battery-plan-section');
        await expect(section).toContainText('Charge from grid');
        await expect(section).toContainText('Supply the house');
        await setMdValue(page, '#device-detail-battery-plan-reserve', '35');
        await section.getByRole('button', { name: 'Save battery plan', exact: true }).click();
        await expect(section).toContainText('Reserve line: 35%');
        await expect(section.locator('#device-detail-battery-plan-reserve')).toHaveJSProperty('value', '35');
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(mobile);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-base-black').trim()))
          .toBe(mobile ? '#0c111b' : '#f6f7fb');
        await page.screenshot({ path: testInfo.outputPath(`continuous-battery-plan-${width}-${mobile ? 'dark' : 'light'}.png`) });
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(mobile);
        const layout = await section.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
        expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
        await section.locator('md-switch').click();
        await section.getByRole('button', { name: 'Save battery plan', exact: true }).click();
        await expect(section).toContainText('Continuous planning is off');
      });
    });
  }
}
