import { expect, test, type Page } from './fixtures/test';

const openLimitsAndSafety = async (page: Page) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="limits"]').click();
  await expect(page.locator('#limits-panel')).toBeVisible();
};

const setMaterialSelectValue = async (page: Page, selector: string, value: string) => {
  await page.locator(selector).evaluate((el, nextValue) => {
    const target = el as HTMLElement & { value: string };
    target.value = nextValue;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

test.describe('Power source setting', () => {
  test('defaults to "Flow card" when no setting is stored', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    const select = page.locator('#settings-power-source');
    await expect(select).toBeVisible();
    await expect(select).toHaveJSProperty('value', 'flow');
  });

  test('loads persisted "homey_energy" value on startup', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__PELS_HOMEY_STUB__ = {
        settings: { power_source: 'homey_energy' },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    await expect(page.locator('#settings-power-source')).toHaveJSProperty('value', 'homey_energy');
  });

  test('saves power source change and shows toast', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    const select = page.locator('#settings-power-source');
    await expect(select).toHaveJSProperty('value', 'flow');

    await setMaterialSelectValue(page, '#settings-power-source', 'homey_energy');
    await expect(page.locator('#toast')).toContainText('Limits & safety saved');

    // Verify the setting was persisted in the Homey stub
    const stored = await page.evaluate(() => {
      return new Promise<unknown>((resolve, reject) => {
        (window as any).Homey.get(
          'power_source',
          (error: Error | null, value?: unknown) => {
            if (error) reject(error);
            else resolve(value);
          },
        );
      });
    });
    expect(stored).toBe('homey_energy');
  });

  test('switching back to "flow" persists correctly', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__PELS_HOMEY_STUB__ = {
        settings: { power_source: 'homey_energy' },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    const select = page.locator('#settings-power-source');
    await expect(select).toHaveJSProperty('value', 'homey_energy');

    await setMaterialSelectValue(page, '#settings-power-source', 'flow');
    await expect(page.locator('#toast')).toContainText('Limits & safety saved');

    const stored = await page.evaluate(() => {
      return new Promise<unknown>((resolve, reject) => {
        (window as any).Homey.get(
          'power_source',
          (error: Error | null, value?: unknown) => {
            if (error) reject(error);
            else resolve(value);
          },
        );
      });
    });
    expect(stored).toBe('flow');
  });

  test('a saved non-sensor meter (chosen before the filter) stays selectable under its real name', async ({ page }) => {
    // Backward compat: before the sensor filter the picker listed every
    // power-reporting device, so a user could have saved e.g. an EV charger.
    // That selection must survive with its real device name, not "not found".
    await page.addInitScript(() => {
      (window as any).__PELS_HOMEY_STUB__ = {
        settings: { power_source: 'homey_energy', homey_energy_meter_device_id: 'dev_evcharger' },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    const meterSelect = page.locator('#settings-homey-energy-meter');
    await expect(meterSelect).toBeVisible();
    await expect(meterSelect).toHaveJSProperty('value', 'dev_evcharger');
    // Automatic + the HAN sensor + the passthrough entry for the saved charger.
    const savedOption = meterSelect.locator('md-select-option[value="dev_evcharger"]');
    await expect(savedOption).toHaveCount(1);
    await expect(savedOption).toContainText('Generic EV Charger');
    await expect(savedOption).not.toContainText('not found');
  });

  test('meter-backed source is labelled "Power meter" and lists only sensor-class meters', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    await expect(
      page.locator('#settings-power-source md-select-option[value="homey_energy"]'),
    ).toContainText('Power meter');

    await setMaterialSelectValue(page, '#settings-power-source', 'homey_energy');
    const meterSelect = page.locator('#settings-homey-energy-meter');
    await expect(meterSelect).toBeVisible();
    // Automatic + the HAN sensor; the power-reporting thermostats, water
    // heater, and EV charger in the fixture must not be offered.
    await expect(meterSelect.locator('md-select-option')).toHaveCount(2);
    await expect(meterSelect.locator('md-select-option').nth(0)).toContainText('Automatic');
    await expect(meterSelect.locator('md-select-option').nth(1)).toContainText('HAN power meter');
  });

  test('stale data banner adapts hint text to power source', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    // Force stale power data but keep heartbeat fresh so the banner shows
    // the power-specific message rather than the heartbeat-missing message
    await page.evaluate(() => {
      const stub = (window as any).Homey.__stub;
      stub.setSetting('pels_status', { lastPowerUpdate: Date.now() - 120_000 });
      stub.setSetting('app_heartbeat', Date.now());
      stub.emitSettingsSet('pels_status');
    });

    const banner = page.locator('#stale-data-banner');

    // Default (flow) should mention Flow
    await expect(banner).toContainText('Flow');

    // Switch to homey_energy
    await setMaterialSelectValue(page, '#settings-power-source', 'homey_energy');

    // Re-trigger stale banner refresh so the hint text updates
    await page.evaluate(() => {
      const stub = (window as any).Homey.__stub;
      stub.emitSettingsSet('pels_status');
    });

    await expect(banner).toContainText('Homey Energy');
  });
});
