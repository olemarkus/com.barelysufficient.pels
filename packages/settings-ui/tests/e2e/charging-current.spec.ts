import { expect, renderTest as test } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';

for (const width of [320, 480]) {
  for (const mobile of [false, true]) {
    test.describe(`${width}px ${mobile ? 'dark' : 'light'}`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
      test.skip(({ browserName }) => mobile && browserName === 'firefox', 'Mobile host emulation uses Chromium');

      test('sets up a shared key without switching an existing Flow and shows removal guidance', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
          const setup = { method: 'flow', confirmation: 'single_charger' };
          let configured = false;
          let saveAttempts = 0;
          let conflict = true;
          const charger = { deviceId: 'charging-test', name: 'Garage charger', setup,
            capabilityWritable: false, scope: 'installation',
            sharedInstallation: false, flowCheck: 'conflict', flowNames: ['Current bridge'] };
          (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
            settings: {
              target_devices_snapshot: [{ id: charger.deviceId, name: charger.name, available: true,
                deviceClass: 'evcharger', isEvCharger: true, capabilities: ['evcharger_charging', 'measure_power'],
                binaryControllable: true, canSetControl: true, powerCapable: true, targets: [],
                controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true } }],
              managed_devices: { 'charging-test': true }, controllable_devices: { 'charging-test': true },
            },
            apiHandlers: {
              'GET /ui_charging_current': () => [{ ...charger, flowCheck: conflict ? 'conflict' : 'clear' }],
              'GET /ui_charging_access': () => ({ configured, state: configured ? 'ready' : 'not_configured' }),
              'PUT /ui_charging_access': () => {
                if (++saveAttempts === 1) throw new Error('Charging access could not be saved. Try again.');
                configured = true; return { configured, state: 'ready' };
              },
              'POST /ui_charging_access/check': () => { conflict = false; return { configured, state: 'ready' }; },
              'PUT /ui_charging_current/charging-test': () => { setup.method = 'built_in'; },
              'DELETE /ui_charging_access': () => { configured = false; return { configured, state: 'not_configured' }; },
            },
          };
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
        await page.locator('#devices-panel [data-device-id="charging-test"] .pels-device-card__detail-button').first().click();
        const disclosure = page.locator('#device-detail-setup-disclosure');
        await disclosure.locator('summary').first().click();
        const section = page.locator('#device-detail-charging-current');
        await expect(section).toContainText('Flow control is selected');
        await section.screenshot({ path: testInfo.outputPath('charging-current-before-key.png') });
        await setMdValue(page, '#device-detail-charging-current md-filled-text-field', 'test-private-key');
        await section.getByRole('button', { name: 'Save key', exact: true }).click();
        await expect(section).toContainText('Charging access could not be saved. Try again.');
        await expect(section.locator('md-filled-text-field')).toHaveJSProperty('value', 'test-private-key');
        await section.screenshot({ path: testInfo.outputPath('charging-current-save-failed.png') });
        await section.getByRole('button', { name: 'Save key', exact: true }).click();
        await expect(section).toContainText('Flow permission verified');
        await expect(section).toContainText('Remove the current-setting action');
        await expect(section.getByRole('button', { name: 'Use built-in control', exact: true })).toBeDisabled();
        await expect(section.locator('md-filled-text-field')).toHaveJSProperty('value', '');
        await section.screenshot({ path: testInfo.outputPath('charging-current-conflict.png') });
        await section.getByRole('button', { name: 'Check again', exact: true }).click();
        await expect(section.getByRole('button', { name: 'Use built-in control', exact: true })).toBeEnabled();
        await section.getByRole('button', { name: 'Use built-in control', exact: true }).click();
        await expect(section.getByRole('button', { name: 'Use a Flow', exact: true })).toBeVisible();
        await section.screenshot({ path: testInfo.outputPath('charging-current-active.png') });
        const layout = await section.evaluate((element) => {
          const right = element.getBoundingClientRect().right;
          return { width: element.clientWidth, scrollWidth: element.scrollWidth,
            overflow: [...element.querySelectorAll('*')].filter((child) => child.getBoundingClientRect().right > right + 1)
              .map((child) => ({ tag: child.tagName, class: child.className, right: child.getBoundingClientRect().right })) };
        });
        expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
      });

    });
  }
}
