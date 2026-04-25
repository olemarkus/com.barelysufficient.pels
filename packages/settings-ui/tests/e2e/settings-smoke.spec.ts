import { expect, test } from './fixtures/test';

test.describe('Settings UI (smoke)', () => {
  test('loads control center', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Control center' })).toBeVisible();
    await expect(page.locator('#overview-panel')).toBeVisible();
  });

  test('can navigate core tabs and render device/mode data', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Control center' })).toBeVisible();

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

  test('advanced EV toggle controls EV visibility in the device list', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');

    await page.getByRole('tab', { name: 'Devices' }).click();
    await expect(page.locator('#device-list')).not.toContainText('EV Charger');

    await page.getByRole('tab', { name: 'Advanced' }).click();
    const evToggle = page.locator('#advanced-ev-support-enabled');
    await expect(evToggle).not.toBeChecked();

    await evToggle.check();
    await expect(page.locator('#toast')).toContainText('EV charger support enabled.');

    await page.getByRole('tab', { name: 'Devices' }).click();
    await expect(page.locator('#device-list')).toContainText('EV Charger');

    await page.getByRole('tab', { name: 'Advanced' }).click();
    await evToggle.uncheck();
    await expect(page.locator('#toast')).toContainText('Managed EV chargers were set to unmanaged.');

    await page.getByRole('tab', { name: 'Devices' }).click();
    await expect(page.locator('#device-list')).not.toContainText('EV Charger');

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
