import { test, expect } from '@playwright/test';

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

  test('keeps stubbed daily budget API payloads in sync with settings writes', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

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
