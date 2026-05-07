import { expect, test, type Page } from './fixtures/test';

const useLegacyUi = async (page: Page) => {
  await page.addInitScript(() => {
    (window as any).__PELS_HOMEY_STUB__ = {
      overviewRedesignEnabled: false,
    };
  });
};

const openSettingsSection = async (page: Page, section: string) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(section) }).click();
};

test.describe('Settings UI (smoke)', () => {
  test('loads control center', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.locator('#overview-panel')).toBeVisible();
  });

  test('keeps legacy top-level navigation available when the new UI is disabled', async ({ page }) => {
    await useLegacyUi(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist')).toBeVisible();

    await page.getByRole('tab', { name: 'Devices' }).click();
    await expect(page.locator('#devices-panel')).toBeVisible();
    await expect(page.locator('#device-list')).toContainText('Living Room Heat Pump');

    await page.getByRole('tab', { name: 'Modes' }).click();
    await expect(page.locator('#modes-panel')).toBeVisible();
    await expect(page.locator('#active-mode-select')).toContainText('Home');
    await expect(page.locator('#active-mode-select')).toContainText('Away');

    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-panel')).toBeVisible();

    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.locator('#usage-panel')).toBeVisible();

    await page.getByRole('tab', { name: 'Price' }).click();
    await expect(page.locator('#price-panel')).toBeVisible();

    await page.getByRole('tab', { name: 'Advanced' }).click();
    await expect(page.locator('#advanced-panel')).toBeVisible();
  });

  test('routes Settings-owned areas through the new UI Settings shell', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Budget' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Usage' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Devices' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Price' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveCount(0);

    await openSettingsSection(page, 'Limits & safety');
    await expect(page.locator('#limits-panel')).toBeVisible();
    await expect(page.locator('#settings-capacity-limit')).toBeVisible();

    await openSettingsSection(page, 'Devices');
    await expect(page.locator('#devices-panel')).toBeVisible();
    await expect(page.locator('#device-list')).toContainText('Living Room Heat Pump');

    await openSettingsSection(page, 'Modes');
    await expect(page.locator('#modes-panel')).toBeVisible();
    await expect(page.locator('#active-mode-select')).toContainText('Home');

    await openSettingsSection(page, 'Price');
    await expect(page.locator('#price-panel')).toBeVisible();

    await openSettingsSection(page, 'Simulation mode');
    await expect(page.locator('#simulation-panel')).toBeVisible();
    await expect(page.locator('#settings-simulation-mode')).toBeVisible();

    await openSettingsSection(page, 'Advanced');
    await expect(page.locator('#advanced-panel')).toBeVisible();
  });

  test('lets users turn off simulation mode from the warning banner', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#dry-run-banner')).toContainText('Simulation mode is enabled');
    await page.getByRole('button', { name: 'Turn off simulation' }).click();

    await expect(page.locator('#toast')).toContainText('Simulation mode updated.');
    await expect(page.locator('#dry-run-banner')).toBeHidden();

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Simulation mode/ }).click();
    await expect(page.locator('#settings-simulation-mode')).not.toBeChecked();

    const stored = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      (window as any).Homey.get('capacity_dry_run', (error: Error | null, value?: unknown) => {
        if (error) reject(error);
        else resolve(value);
      });
    }));
    expect(stored).toBe(false);
  });

  test('advanced EV toggle controls EV visibility in the device list', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');

    await openSettingsSection(page, 'Devices');
    const genericEvDeviceRow = page.locator('[data-device-id="dev_evcharger"]');
    await expect(genericEvDeviceRow).toHaveCount(0);

    await openSettingsSection(page, 'Advanced');
    const evToggle = page.locator('#advanced-ev-support-enabled');
    await expect(evToggle).not.toBeChecked();

    await evToggle.check();
    await expect(page.locator('#toast')).toContainText('EV charger support enabled.');

    await openSettingsSection(page, 'Devices');
    await expect(genericEvDeviceRow).toBeVisible();

    await openSettingsSection(page, 'Advanced');
    await evToggle.uncheck();
    await expect(page.locator('#toast')).toContainText('Managed EV chargers were set to unmanaged.');

    await openSettingsSection(page, 'Devices');
    await expect(genericEvDeviceRow).toHaveCount(0);

    const managedMap = await page.evaluate(async () => {
      const homey = (window as unknown as {
        Homey: {
          get: (key: string, callback: (error: Error | null, value?: unknown) => void) => void;
        };
      }).Homey;
      return await new Promise<Record<string, boolean>>((resolve, reject) => {
        homey.get('managed_devices', (error: Error | null, value?: unknown) => {
          if (error) {
            reject(error);
            return;
          }
          resolve((value ?? {}) as Record<string, boolean>);
        });
      });
    });

    expect(managedMap.dev_evcharger).toBe(false);
  });

  test('keeps stubbed daily budget API payloads in sync with settings writes', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');

    const payload = await page.evaluate(async () => {
      const homey = (window as unknown as {
        Homey: {
          set: (key: string, value: unknown, callback: (error?: Error | null) => void) => void;
          api: (
            method: string,
            uri: string,
            bodyOrCallback: unknown,
            callback?: (error: Error | null, result?: unknown) => void,
          ) => void;
        };
      }).Homey;
      const stub = homey as {
        set: (key: string, value: unknown, callback: (error?: Error | null) => void) => void;
        api: (
          method: string,
          uri: string,
          bodyOrCallback: unknown,
          callback?: (error: Error | null, result?: unknown) => void,
        ) => void;
      };
      await new Promise<void>((resolve, reject) => {
        stub.set('daily_budget_kwh', 7, (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        stub.set('daily_budget_enabled', false, (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      const dailyBudget = await new Promise<any>((resolve, reject) => {
        stub.api('GET', '/daily_budget', (error: Error | null, result?: unknown) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        });
      });
      const bootstrap = await new Promise<any>((resolve, reject) => {
        stub.api('GET', '/ui_bootstrap', (error: Error | null, result?: unknown) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        });
      });
      const today = dailyBudget?.days?.[dailyBudget?.todayKey ?? ''] ?? null;
      return {
        bootstrapBudgetKwh: bootstrap?.settings?.daily_budget_kwh ?? null,
        bootstrapDailyBudgetEnabled: bootstrap?.settings?.daily_budget_enabled ?? null,
        budgetEnabled: today?.budget?.enabled ?? null,
        budgetKwh: today?.budget?.dailyBudgetKWh ?? null,
      };
    });

    expect(payload).toEqual({
      bootstrapBudgetKwh: 7,
      bootstrapDailyBudgetEnabled: false,
      budgetEnabled: false,
      budgetKwh: 7,
    });
  });
});
