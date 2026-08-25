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
    await expect(page.locator('#toast')).toContainText('Power source saved');

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
    await expect(page.locator('#toast')).toContainText('Power source saved');

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

  test('refuses switching to Flow while a meter area runs and rolls the select back', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__PELS_HOMEY_STUB__ = {
        settings: {
          power_source: 'homey_energy',
          homey_energy_meter_device_id: 'dev_han',
          homes_config: {
            activationVersion: 1,
            subHomes: [{
              homeId: 'h_rental',
              name: 'Rental unit',
              rootZoneId: 'z_rental',
              meterDeviceId: 'dev_subpanel',
            }],
          },
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    const select = page.locator('#settings-power-source');
    await expect(select).toHaveJSProperty('value', 'homey_energy');
    await setMaterialSelectValue(page, '#settings-power-source', 'flow');

    // The refusal names the remedy and the screen never shows the unsaved choice.
    await expect(page.locator('#toast'))
      .toContainText('Remove your meter areas under Multiple meters first');
    await expect(select).toHaveJSProperty('value', 'homey_energy');
    const stored = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      (window as any).Homey.get(
        'power_source',
        (error: Error | null, value?: unknown) => (error ? reject(error) : resolve(value)),
      );
    }));
    expect(stored).toBe('homey_energy');
  });

  test('offers a resolved sub-meter (unmarked sensor meter), not just the whole-home-marked one', async ({ page }) => {
    // The "only Automatic" fix: an unmarked but real (sensor-class) sub-meter is
    // resolved by the endpoint alongside the whole-home cumulative meter. Both
    // must be offered and selectable — the old picker dropped the sub-meter.
    await page.addInitScript(() => {
      (window as any).__PELS_HOMEY_STUB__ = {
        settings: { power_source: 'homey_energy' },
        apiHandlers: {
          'GET /homey_energy_meters': () => [
            { id: 'dev_han', name: 'HAN power meter' },
            { id: 'dev_subpanel', name: 'Garage submeter' },
          ],
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    const meterSelect = page.locator('#settings-homey-energy-meter');
    await expect(meterSelect).toBeVisible();
    // Automatic + both resolved meters (the sub-meter included).
    await expect(meterSelect.locator('md-select-option')).toHaveCount(3);
    const subpanel = meterSelect.locator('md-select-option[value="dev_subpanel"]');
    await expect(subpanel).toContainText('Garage submeter');

    await setMaterialSelectValue(page, '#settings-homey-energy-meter', 'dev_subpanel');
    await expect(page.locator('#toast')).toContainText('Whole-home meter saved');
    const stored = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      (window as any).Homey.get(
        'homey_energy_meter_device_id',
        (error: Error | null, value?: unknown) => (error ? reject(error) : resolve(value)),
      );
    }));
    expect(stored).toBe('dev_subpanel');
  });

  test('rejects a Whole-home meter already owned by a meter area and rolls the picker back', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__PELS_HOMEY_STUB__ = {
        settings: {
          power_source: 'homey_energy',
          homes_config: {
            activationVersion: 1,
            subHomes: [{
              homeId: 'h_rental',
              name: 'Rental unit',
              rootZoneId: 'z_rental',
              meterDeviceId: 'dev_subpanel',
            }],
          },
        },
        apiHandlers: {
          'GET /homey_energy_meters': () => [
            { id: 'dev_han', name: 'HAN power meter' },
            { id: 'dev_subpanel', name: 'Rental meter' },
          ],
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    const meterSelect = page.locator('#settings-homey-energy-meter');
    await expect(meterSelect).toHaveJSProperty('value', '');
    await setMaterialSelectValue(page, '#settings-homey-energy-meter', 'dev_subpanel');

    await expect(page.locator('#toast')).toContainText('“Rental unit” already uses this meter.');
    await expect(meterSelect).toHaveJSProperty('value', '');
    const stored = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      (window as any).Homey.get(
        'homey_energy_meter_device_id',
        (error: Error | null, value?: unknown) => (error ? reject(error) : resolve(value)),
      );
    }));
    expect(stored).toBeUndefined();
  });

  test('meter-backed source is labelled "Power meter" and lists the energy report meters', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    await expect(
      page.locator('#settings-power-source md-select-option[value="homey_energy"]'),
    ).toContainText('Power meter');

    await setMaterialSelectValue(page, '#settings-power-source', 'homey_energy');
    const meterSelect = page.locator('#settings-homey-energy-meter');
    await expect(meterSelect).toBeVisible();
    // Automatic + exactly the meters the Homey Energy report exposes (here the
    // single whole-home HAN) — not a capability/class-filtered device list.
    await expect(meterSelect.locator('md-select-option')).toHaveCount(2);
    await expect(meterSelect.locator('md-select-option').nth(0)).toContainText('Automatic');
    await expect(meterSelect.locator('md-select-option').nth(1)).toContainText('HAN power meter');
  });

  test('stale data banner adapts hint text to power source', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    // Force stale power data but keep heartbeat fresh so the banner shows
    // the power-specific message rather than the heartbeat-missing message.
    // Production's stale home is "total present, timestamp OLD" — the tracker
    // keeps its latch (so the home stays measured and the status read stays
    // live) while both stamps age past the banner threshold. The banner reads
    // the tracker stamp first, so aging only the blob would leave the default
    // fixture's fresh tracker hiding it.
    await page.evaluate(() => {
      const stub = (window as any).Homey.__stub;
      stub.setSetting('power_tracker_state', { lastPowerW: 5200, lastTimestamp: Date.now() - 120_000 });
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
