import { expect, renderTest as test } from './fixtures/test';
import { setMdSwitch, setMdValue } from './fixtures/materialWeb';
import type { StubWindow } from './stubWindow';

for (const width of [320, 480]) {
  for (const mobile of [false, true]) {
    test.describe(`${width}px ${mobile ? 'dark' : 'light'} charging phases`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
      test.skip(({ browserName }) => mobile && browserName === 'firefox', 'Touch emulation uses Chromium');

      test('requires the installation and house phase before enabling control', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
          const config = { enabled: true, preset: 'ev_charger_3_phase', min: 0, max: 11040,
            step: 690, excludeMin: 1, excludeMax: 4140 };
          (window as unknown as StubWindow).__PELS_HOMEY_STUB__ = { settings: {
            target_devices_snapshot: [{ id: 'phase-charger', name: 'Garage charger', available: true,
              deviceClass: 'evcharger', deviceType: 'onoff', isEvCharger: true, evChargingState: 'plugged_in',
              capabilities: ['evcharger_charging', 'measure_power'], targets: [], binaryControllable: true,
              canSetControl: true, powerCapable: true, controlModel: 'stepped_load', targetPowerConfig: config,
              steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0, planningCurrentA: 0 },
                { id: '6a', planningPowerW: 4140, planningCurrentA: 6 }] },
              chargingPhaseControl: { kind: 'supported', deviceId: 'phase-charger', mode: 'charger',
                installationConfirmed: false, status: { kind: 'charger' } } }],
            main_fuse_supply: 'three_phase_neutral',
            managed_devices: { 'phase-charger': true }, controllable_devices: { 'phase-charger': true },
            device_target_power_configs: { 'phase-charger': config },
          } };
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
        await page.locator('#devices-panel [data-device-id="phase-charger"] .pels-device-card__detail-button')
          .first().click();
        const setup = page.locator('#device-detail-setup-disclosure');
        if (!await setup.evaluate((element) => (element as HTMLDetailsElement).open)) {
          await setup.locator('summary').first().click();
        }
        const section = page.locator('#device-detail-charging-phases');
        await expect(section.getByRole('heading', { name: 'Charging phases', exact: true })).toBeVisible();
        await setMdValue(page, '#device-detail-charging-phases md-filled-select', 'automatic');
        const save = section.getByRole('button', { name: 'Save charging phases', exact: true });
        await expect(save).toBeDisabled();
        await expect(section.locator('md-filled-select').nth(1)).toHaveJSProperty('value', 'unselected');
        await setMdSwitch(page, '#device-detail-charging-phases md-switch', true);
        await expect(save).toBeDisabled();
        await section.locator('md-filled-select').nth(1).evaluate((element) => {
          (element as HTMLElement & { value: string }).value = 'L2';
          element.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(save).toBeEnabled();
        await save.click();
        await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
          (window as unknown as StubWindow).Homey.get('charging_phase_control', (_error, value) => resolve(value));
        }))).toEqual({ 'phase-charger': { mode: 'automatic', installationConfirmed: true } });
        await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
          (window as unknown as StubWindow).Homey.get('device_phase_connections', (_error, value) => resolve(value));
        }))).toEqual({ 'phase-charger': 'three_L2' });
        await expect(save).toBeEnabled();
        await expect(page.locator('#device-detail-electrical-connection')).toHaveJSProperty('value', 'three_L2');
        await setMdValue(page, '#device-detail-electrical-connection', 'three_L3');
        await expect(section.locator('md-filled-select').nth(1)).toHaveJSProperty('value', 'L3');
        await setMdValue(page, '#device-detail-charging-phases md-filled-select:first-of-type', 'single');
        await save.click();
        await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
          (window as unknown as StubWindow).Homey.get('charging_phase_control', (_error, value) => resolve(value));
        }))).toEqual({ 'phase-charger': { mode: 'single', installationConfirmed: true } });
        await expect(page.locator('#device-detail-electrical-connection')).toHaveJSProperty('value', 'three_L3');
        await expect(save).toBeEnabled();
        await expect(section.locator('label.md-switch-row')).not.toHaveClass(/md-switch-row--disabled/);
        await section.screenshot({ path: testInfo.outputPath('charging-phases.png') });
        expect(await page.locator('#device-detail-panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth))
          .toBe(true);
      });
    });
  }
}
