import { expect, renderTest as test, type Page } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';
import type { StubWindow } from './stubWindow';
import type { EvChargingCurrentLimitsMap } from '../../../contracts/src/types';

const MIN_FIELD = '#car-charging-current-family-car-min';
const MAX_FIELD = '#car-charging-current-family-car-max';

const readLimits = (page: Page, key = 'ev_car_current_limits'): Promise<EvChargingCurrentLimitsMap> => page.evaluate((settingKey) => (
  new Promise<EvChargingCurrentLimitsMap>((resolve, reject) => {
    (window as unknown as StubWindow).Homey.get(settingKey, (error, value) => {
      if (error) reject(error);
      else resolve(value as EvChargingCurrentLimitsMap);
    });
  })
), key);

for (const width of [320, 480]) {
  for (const mobile of [false, true]) {
    test.describe(`${width}px ${mobile ? 'dark' : 'light'} car current limits`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
      test.skip(({ browserName }) => mobile && browserName === 'firefox', 'Mobile host emulation uses Chromium');

      test('shares one car range across chargers and can clear it', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
          const config = { enabled: true, preset: 'ev_charger_1_phase', min: 0, max: 7360,
            step: 460, excludeMin: 1, excludeMax: 1380 };
          const charger = { id: 'amp-limits-test', name: 'Garage charger', available: true,
            deviceClass: 'evcharger', deviceType: 'onoff', isEvCharger: true,
            evChargingState: 'plugged_in',
            capabilities: ['evcharger_charging', 'measure_power'], targets: [],
            binaryControllable: true, canSetControl: true, powerCapable: true,
            expectedPowerKw: 7.36, expectedPowerSource: 'default', controlModel: 'stepped_load',
            targetPowerConfig: config,
            steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0, planningCurrentA: 0 },
              { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
              { id: '16a', planningPowerW: 3680, planningCurrentA: 16 }] } };
          (window as unknown as StubWindow).__PELS_HOMEY_STUB__ = {
            settings: {
              target_devices_snapshot: [charger, { ...charger, id: 'other-charger', name: 'Driveway charger' }],
              managed_devices: { 'amp-limits-test': true, 'other-charger': true },
              controllable_devices: { 'amp-limits-test': true, 'other-charger': true },
              device_target_power_configs: { 'amp-limits-test': config, 'other-charger': config },
              ev_car_associations: {
                'amp-limits-test': { carIds: ['family-car'] }, 'other-charger': { carIds: ['family-car'] },
              },
              ev_car_current_limits: { 'other-car': { minA: 6, maxA: 16 } },
              ev_charger_current_limits: { 'other-charger': { minA: 10, maxA: 20 } },
            },
            apiHandlers: {
              'GET /ui_charging_current': () => [],
              'GET /ui_recommendation_cars': () => ({ state: 'resolved', cars: [
                { id: 'family-car', name: 'Family car', matchHistory: { state: 'resolved', chargerMatches: [] } },
              ] }),
            },
          };
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
        const openDetail = async (deviceId: string) => {
          await page.locator(`#devices-panel [data-device-id="${deviceId}"] .pels-device-card__detail-button`).first().click();
        };
        await openDetail('amp-limits-test');
        const section = page.locator('[data-car-current-limits="family-car"]');
        await expect(section.getByRole('heading', { name: 'Charging current limits for Family car', exact: true })).toBeVisible();
        await expect(page.locator(MIN_FIELD)).toHaveJSProperty('value', '6');
        await expect(page.locator(MAX_FIELD)).toHaveJSProperty('value', '32');
        const setup = page.locator('#device-detail-setup-disclosure');
        if (!await setup.evaluate((element) => (element as HTMLDetailsElement).open)) {
          await setup.locator('summary').first().click();
        }
        const chargerDefault = page.locator('#device-detail-charger-current-limits');
        await expect(chargerDefault.getByRole('heading', { name: 'Default charging current limits', exact: true })).toBeVisible();
        await setMdValue(page, '#charger-charging-current-amp-limits-test-min', '9');
        await setMdValue(page, '#charger-charging-current-amp-limits-test-max', '16');
        await chargerDefault.getByRole('button', { name: 'Save charger default', exact: true }).click();
        await expect.poll(async () => (await readLimits(page, 'ev_charger_current_limits'))['amp-limits-test'])
          .toEqual({ minA: 9, maxA: 16 });
        await expect(page.locator(MIN_FIELD)).toHaveJSProperty('value', '9');
        await expect(page.locator(MAX_FIELD)).toHaveJSProperty('value', '16');
        await expect(section).toContainText('Using charger default');
        await chargerDefault.screenshot({ path: testInfo.outputPath('charger-default-current-limits.png') });
        const save = section.getByRole('button', { name: 'Save car override', exact: true });

        await setMdValue(page, MIN_FIELD, '26');
        await setMdValue(page, MAX_FIELD, '25');
        await save.click();
        await expect(section.getByRole('alert')).toContainText('Minimum must not exceed maximum');
        expect((await readLimits(page))['family-car']).toBeUndefined();
        await section.screenshot({ path: testInfo.outputPath('car-current-limits-invalid.png') });

        await setMdValue(page, MIN_FIELD, '9');
        await save.click();
        await expect.poll(async () => (await readLimits(page))['family-car']).toEqual({ minA: 9, maxA: 25 });
        expect((await readLimits(page))['other-car']).toEqual({ minA: 6, maxA: 16 });
        await expect(section.getByRole('alert')).toHaveCount(0);

        await page.locator('#device-detail-close').click();
        await expect(page.locator('#device-detail-overlay')).toBeHidden();
        await page.evaluate(() => (window as unknown as StubWindow).Homey.__stub.emitSettingsSet('ev_car_current_limits'));
        await openDetail('other-charger');
        await expect(page.locator(MIN_FIELD)).toHaveJSProperty('value', '9');
        await expect(page.locator(MAX_FIELD)).toHaveJSProperty('value', '25');
        await section.screenshot({ path: testInfo.outputPath('car-current-limits-saved.png') });
        const layout = await section.evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
        expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
        expect(await page.locator('#device-detail-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
        await section.getByRole('button', { name: 'Use charger default', exact: true }).click();
        await expect.poll(async () => (await readLimits(page))['family-car']).toBeUndefined();
        expect((await readLimits(page))['other-car']).toEqual({ minA: 6, maxA: 16 });
        await expect(page.locator(MIN_FIELD)).toHaveJSProperty('value', '10');
        await expect(page.locator(MAX_FIELD)).toHaveJSProperty('value', '20');
      });
    });
  }
}
