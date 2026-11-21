import { expect, renderTest as test } from './fixtures/test';
import { setMdSwitch } from './fixtures/materialWeb';

for (const width of [320, 480]) {
  for (const dark of [false, true]) {
    test.describe(`${width}px ${dark ? 'dark' : 'light'}`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: dark, hasTouch: dark });
      test.skip(({ browserName }) => dark && browserName === 'firefox', 'Mobile host emulation uses Chromium');

      test('finishes car control from a saved solar choice', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
          let setup = { method: 'built_in', confirmation: 'none' };
          const car = { id: 'solar-car', name: 'Electric car', available: true, managed: true,
            deviceClass: 'sensor', deviceType: 'onoff', isEvCharger: true, isBatteryOrSolar: false,
            binaryControllable: true, powerCapable: true, targets: [], measuredPowerKw: 0,
            expectedPowerKw: 3.68, expectedPowerSource: 'default', controlModel: 'stepped_load',
            capabilities: ['measure_power'],
            steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 },
              { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
              { id: '16a', planningPowerW: 3680, planningCurrentA: 16 }] } };
          (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
            settings: {
              target_devices_snapshot: [car], managed_devices: { 'solar-car': true },
              controllable_devices: { 'solar-car': true }, capacity_enabled: false,
              capacity_dry_run: true, daily_budget_enabled: false, ui_hub_market_country: 'NL',
              price_optimization_settings: { 'solar-car': { enabled: false, cheapDelta: 0, expensiveDelta: 0,
                priceConfigured: false, surplusWilling: true, surplusDelta: 0 } },
              ui_devices_has_managed_solar: true, ui_devices_surplus_pool_reachable: true,
            },
            apiHandlers: {
              'GET /ui_devices': () => ({ devices: [car], hasManagedSolarDevice: true,
                hasExhibitedExport: false, surplusPoolReachable: true,
                chargerPhasePresets: { state: 'resolved', presets: {} } }),
              'GET /ui_charging_current': () => [{ deviceId: car.id, name: car.name, setup,
                scope: 'vehicle', supportsAppAction: true, capabilityWritable: false, sharedInstallation: false,
                flowCheck: 'clear', flowNames: [], currentRoute: setup.method, missingCompanion: 'none' }],
              'GET /ui_charging_access': () => ({ configured: true, state: 'ready' }),
              'PUT /ui_charging_current/solar-car': (body: typeof setup) => { setup = body; },
            },
          };
        });
        await page.goto('/?page=settings/setup-review&setup=review', { waitUntil: 'domcontentloaded' });
        const review = page.locator('#setup-review-root [data-device-id="solar-car"]');
        await expect(review).toContainText('Turn on “Control charging through this car” in Setup.');
        await expect(review).not.toContainText('Power-limit control on');
        await expect(page.locator('[data-setup-review="no-job"]'))
          .toContainText('No device has a job PELS can act on yet.');
        await page.locator('#setup-review-root').screenshot({ path: testInfo.outputPath('review-needs-charging-setup.png') });
        await review.getByRole('button', { name: 'Finish charging setup', exact: true }).click();
        const disclosure = page.locator('#device-detail-setup-disclosure');
        const consent = page.locator('#device-detail-vehicle-control');
        await expect(disclosure).toHaveJSProperty('open', true);
        await expect(consent).toBeInViewport();
        await expect(consent).toBeFocused();
        await expect(consent).toHaveJSProperty('selected', false);

        const notice = page.locator('#device-detail-solar-charging-setup');
        await expect(notice).toBeVisible();
        await expect(page.locator('#device-detail-surplus-track-opt')).toHaveJSProperty('selected', true);
        await page.locator('#device-detail-charging-section').screenshot({ path: testInfo.outputPath('solar-needs-car-control.png') });
        await notice.getByRole('button', { name: 'Finish charging setup', exact: true }).click();
        await expect(consent).toBeInViewport();
        await expect(consent).toBeFocused();
        await setMdSwitch(page, '#device-detail-vehicle-control', true);
        await page.getByRole('button', { name: 'Save car control', exact: true }).click();
        await expect(notice).toBeHidden();
        await expect(page.locator('#device-detail-surplus-track-opt')).toHaveJSProperty('selected', true);
        const panel = page.locator('#device-detail-panel');
        const overflow = await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
        expect(overflow).toBe(false);
        await page.locator('#device-detail-charging-section').screenshot({ path: testInfo.outputPath('solar-car-control-ready.png') });
      });
    });
  }
}
