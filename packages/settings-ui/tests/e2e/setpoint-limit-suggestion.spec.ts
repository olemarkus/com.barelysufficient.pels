import { expect, test } from './fixtures/test';
import { readMdValue, setMdValue } from './fixtures/materialWeb';

// A water heater PELS can limit only through its target, with no limited
// temperature saved: PELS uses the device minimum, so it suggests setting one, opens the device at that field, and
// stops suggesting it once one is saved.
test.describe('Limited temperature suggestion', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const target = { id: 'target_temperature', unit: '°C', value: 65, min: 10, max: 75 };
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          target_devices_snapshot: [{
            id: 'dev_oso',
            zone: 'Utility room',
            zoneId: 'z_utility',
            name: 'Water Heater',
            deviceClass: 'heater',
            deviceType: 'temperature',
            capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
            powerCapable: true,
            targets: [target],
            currentTemperature: 58,
            temperature: { currentTemperature: 58, target },
            measuredPowerKw: 0,
            expectedPowerKw: 3,
            expectedPowerSource: 'measured-peak',
          }],
          managed_devices: { dev_oso: true },
          controllable_devices: { dev_oso: true },
          budget_exempt_devices: {},
          capacity_priorities: { Home: { dev_oso: 1 } },
          mode_device_targets: { Home: { dev_oso: 65 }, Away: { dev_oso: 50 } },
          overshoot_behaviors: {},
        },
      };
    });
  });

  test('asks for a limit, opens the device at the field, and goes once one is saved', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const banner = page.locator('#setup-recommendations-banner-root');
    await expect(banner).toContainText('1 recommendation');
    await banner.getByText('Review').click();

    const card = page.locator('#setup-recommendations-root .setup-recommendation-card', {
      hasText: 'Set the limited temperature for Water Heater',
    });
    await expect(card).toContainText('so automatic uses 10 °C (the device’s minimum target)');
    await card.getByText('Set temperature').click();

    // The field the suggestion names, in view, starting at PELS's own choice
    // and going as high as the tank allows.
    const field = page.locator('#device-detail-overshoot-temp');
    await expect(page.locator('#device-detail-overshoot-temp-row')).toBeInViewport();
    expect(await readMdValue(page, '#device-detail-overshoot-temp')).toBe('');
    await expect(field).toHaveJSProperty('max', '75');
    await expect(field).toHaveJSProperty('placeholder', 'Automatic');
    await expect(page.locator('#device-detail-overshoot-temp-hint')).toContainText('10 °C');

    await setMdValue(page, '#device-detail-overshoot-temp', '55');
    await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
      (window as unknown as { Homey: { get: (key: string, cb: (e: unknown, v: unknown) => void) => void } })
        .Homey.get('overshoot_behaviors', (_error, value) => resolve(value));
    }))).toMatchObject({ dev_oso: { action: 'set_temperature', temperature: 55 } });

    await expect(page.locator('#settings-nav-chip-recommendations')).toBeHidden();
  });
});
