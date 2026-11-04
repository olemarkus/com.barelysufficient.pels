import { expect, renderTest as test } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';

for (const width of [320, 480]) {
  for (const mobile of [false, true]) {
    test.describe(`${width}px ${mobile ? 'dark' : 'light'}`, () => {
      test.use({ viewport: { width, height: 1600 }, isMobile: mobile, hasTouch: mobile });
      test.skip(({ browserName }) => mobile && browserName === 'firefox', 'Mobile host emulation uses Chromium');

      test('offers the Homey API key on a battery PELS drives through its app\'s Flow cards', async ({ page }, testInfo) => {
        await page.addInitScript(() => {
          let configured = false;
          const battery = { id: 'battery-key-test', name: 'Marstek Venus', available: true,
            deviceClass: 'battery', isBatteryOrSolar: true, batteryControl: 'needs_homey_api_key', batteryTakenOver: false,
            batteryUsesHomeyApiKey: true, capabilities: ['measure_power', 'measure_battery'], targets: [],
            canSetControl: true, powerCapable: true, expectedPowerKw: 2.5, expectedPowerSource: 'default' };
          (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
            settings: {
              target_devices_snapshot: [battery], battery_control_devices: {},
              controllable_devices: { [battery.id]: true },
            },
            apiHandlers: {
              'GET /ui_charging_access': () => ({ configured, state: configured ? 'ready' : 'not_configured' }),
              'PUT /ui_charging_access': () => { configured = true; return { configured, state: 'ready' }; },
              'DELETE /ui_charging_access': () => { configured = false; return { configured, state: 'not_configured' }; },
            },
          };
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
        await page.locator('#devices-panel [data-device-id="battery-key-test"] .pels-device-card__detail-button').first().click();
        const section = page.locator('#device-detail-battery-api-key');
        await expect(section).toContainText('A Homey API key is needed for PELS to control this battery.');
        await section.screenshot({ path: testInfo.outputPath('battery-api-key-needed.png') });
        await setMdValue(page, '#device-detail-battery-api-key md-filled-text-field', 'test-private-key');
        await section.getByRole('button', { name: 'Save key', exact: true }).click();
        await expect(section.locator('summary')).toHaveText('Manage API key');
        await section.locator('summary').click();
        await expect(section).toContainText('API key verified.');
        await section.screenshot({ path: testInfo.outputPath('battery-api-key-saved.png') });
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
