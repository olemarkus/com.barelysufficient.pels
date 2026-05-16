import { expect, test, type Page } from './fixtures/test';
import { readMdSelectHeadlineText, setMdValue } from './fixtures/materialWeb';

const requestLegacyUi = async (page: Page) => {
  await page.addInitScript(() => {
    (window as any).__PELS_HOMEY_STUB__ = {
      overviewRedesignEnabled: false,
    };
  });
};

const openSettingsSection = async (page: Page, target: string) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const sectionButton = page.locator(`[data-settings-target="${target}"]`);
  await expect(sectionButton).toBeVisible();
  await sectionButton.scrollIntoViewIfNeeded();
  await sectionButton.click();
};

const getRedesignDeviceRow = (page: Page, deviceId: string) => (
  page.locator(`#device-card-list [data-device-id="${deviceId}"]`)
);

const expectModeOption = async (page: Page, mode: string) => {
  await expect(page.locator(`#active-mode-select md-select-option[value="${mode}"]`)).toHaveCount(1);
};

test.describe('Settings UI (smoke)', () => {
  test('loads control center', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.locator('#overview-panel')).toBeVisible();
    await expect(page.locator('#overview-panel')).toContainText('Energy used this hour');
    await expect(page.locator('#overview-panel')).toContainText('0.3 of 4.5 kWh used');
  });

  test('keeps the new UI on when the old local stub requests legacy navigation', async ({ page }) => {
    await requestLegacyUi(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tablist')).toBeVisible();

    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Devices' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Prices' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveCount(0);

    await openSettingsSection(page, 'devices');
    await expect(page.locator('#devices-panel')).toBeVisible();
    await expect(page.locator('#device-card-list')).toContainText('Living Room Heat Pump');
  });

  test('routes Settings-owned areas through the new UI Settings shell', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Budget' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Usage' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Devices' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Prices' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveCount(0);

    await openSettingsSection(page, 'limits');
    await expect(page.locator('#limits-panel')).toBeVisible();
    await expect(page.locator('#settings-capacity-limit')).toBeVisible();

    await openSettingsSection(page, 'devices');
    await expect(page.locator('#devices-panel')).toBeVisible();
    await expect(page.locator('#device-card-list')).toContainText('Living Room Heat Pump');

    await openSettingsSection(page, 'modes');
    await expect(page.locator('#modes-panel')).toBeVisible();
    await expectModeOption(page, 'Home');

    await openSettingsSection(page, 'electricity-prices');
    await expect(page.locator('#electricity-prices-panel')).toBeVisible();

    await openSettingsSection(page, 'price-aware-devices');
    await expect(page.locator('#price-aware-devices-panel')).toBeVisible();

    await openSettingsSection(page, 'simulation');
    await expect(page.locator('#simulation-panel')).toBeVisible();
    await expect(page.locator('#settings-simulation-mode')).toBeVisible();

    await openSettingsSection(page, 'advanced');
    await expect(page.locator('#advanced-panel')).toBeVisible();
  });

  test('renders the selected mode label inside the closed select field on first paint', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');

    await page.getByRole('tab', { name: 'Settings' }).click();
    const activeSelect = page.locator('#active-mode-select');
    await expect(activeSelect).toBeVisible();
    await expect(activeSelect).toHaveJSProperty('value', 'Home');
    await expect.poll(() => readMdSelectHeadlineText(page, '#active-mode-select')).toBe('Home');

    await openSettingsSection(page, 'modes');
    const modeSelect = page.locator('#mode-select');
    await expect(modeSelect).toBeVisible();
    await expect(modeSelect).toHaveJSProperty('value', 'Home');
    await expect.poll(() => readMdSelectHeadlineText(page, '#mode-select')).toBe('Home');
  });

  test('shows and switches the current mode from Settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');

    await page.getByRole('tab', { name: 'Settings' }).click();
    const currentMode = page.locator('#settings-active-mode-summary');
    await expect(currentMode).toHaveText('Home mode');
    await expect(page.locator('#active-mode-select md-select-option[value="Away"]')).toHaveCount(1);

    await setMdValue(page, '#active-mode-select', 'Away');

    await expect(currentMode).toHaveText('Away mode');
    await expect(page.locator('#toast')).toContainText('Active mode set to Away');

    const stored = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      (window as any).Homey.get('operating_mode', (error: Error | null, value?: unknown) => {
        if (error) reject(error);
        else resolve(value);
      });
    }));
    expect(stored).toBe('Away');
  });

  test('lets users turn off simulation mode from the warning banner', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#dry-run-banner')).toContainText('Simulation mode is enabled');
    await page.locator('#simulation-disable-button').click();

    await expect(page.locator('#toast')).toContainText('Simulation mode updated.');
    await expect(page.locator('#dry-run-banner')).toBeHidden();

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('[data-settings-target="simulation"]').click();
    await expect(page.locator('#settings-simulation-mode')).toHaveJSProperty('selected', false);

    const stored = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      (window as any).Homey.get('capacity_dry_run', (error: Error | null, value?: unknown) => {
        if (error) reject(error);
        else resolve(value);
      });
    }));
    expect(stored).toBe(false);
  });

  test('shows the new Budget Plan and Adjust surfaces behind the new UI', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Adjust', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview changes' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Discard preview' })).toHaveCount(0);

    await expect(page.locator('#budget-redesign-comparison')).toContainText('/');
    await expect(page.locator('#budget-redesign-comparison')).toContainText('kWh');
    await expect(page.locator('#budget-plan-summary')).toContainText('to spare now');
    await expect(page.locator('#budget-plan-summary')).toContainText('Managed');
    await expect(page.locator('#budget-plan-summary')).toContainText('Background');
    await expect(page.locator('#budget-redesign-chart')).toBeVisible();
    await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();

    await page.getByRole('button', { name: 'Hourly plan' }).click();
    await expect(page.locator('#budget-redesign-chart-title')).toHaveText('Hourly plan');
    await expect(page.locator('#budget-redesign-chart-subtitle')).toContainText('Budget follows cheaper hours');
    await expect(page.locator('#budget-redesign-chart svg')).toContainText('kr/kWh');

    await page.getByRole('button', { name: 'Tomorrow' }).click();
    await expect(page.locator('#budget-redesign-comparison')).toContainText('kWh');
    await expect(page.locator('#budget-plan-summary .plan-hero__decision')).toContainText('Most planned use');
    await expect(page.locator('#budget-plan-summary .plan-hero__subline')).not.toContainText('to spare now');

    await page.getByRole('button', { name: 'Yesterday' }).click();
    await expect(page.locator('#budget-redesign-comparison')).toContainText('kWh');
    await expect(page.locator('#budget-plan-summary')).not.toContainText('to spare now');

    await page.getByRole('button', { name: 'Adjust', exact: true }).click();
    await expect(page.locator('#budget-redesign-adjust-view')).toBeVisible();
    await expect(page.locator('#budget-redesign-adjust-view')).toContainText('Daily energy');
    await expect(page.locator('#budget-redesign-adjust-view')).toContainText('Planning behavior');
    await expect(page.locator('#budget-redesign-adjust-view')).toContainText('Current limits');

    await expect(page.getByRole('button', { name: 'Preview changes' })).toHaveCount(0);
    const kwhField = page.locator('#budget-redesign-kwh');
    await expect(kwhField).toBeVisible();
    await kwhField.evaluate((el, value) => {
      const target = el as HTMLElement & { value?: string };
      target.value = value;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }, '40');

    const previewButton = page.getByRole('button', { name: 'Preview changes' });
    await expect(previewButton).toBeVisible();
    await previewButton.click();

    await expect(page.locator('#budget-redesign-comparison')).toBeVisible();
    await expect(page.locator('#budget-redesign-comparison')).toContainText('Daily budget');
    await expect(page.locator('#budget-redesign-apply')).toBeVisible();
    const discardButton = page.getByRole('button', { name: 'Discard preview' });
    await expect(discardButton).toBeVisible();

    await discardButton.click();
    await expect(page.locator('#budget-redesign-comparison')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Apply changes' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Preview changes' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Open Limits & safety' }).click();
    await expect(page.locator('#limits-panel')).toBeVisible();
  });

  test('EV chargers are visible in the device list', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');

    await openSettingsSection(page, 'devices');
    const genericEvDeviceRow = getRedesignDeviceRow(page, 'dev_evcharger');
    await expect(genericEvDeviceRow).toBeVisible();
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
