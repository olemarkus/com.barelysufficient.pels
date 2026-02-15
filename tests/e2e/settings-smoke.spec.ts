import { test, expect } from '@playwright/test';

test.describe('Settings UI (smoke)', () => {
  test('loads control center', async ({ page }) => {
    await page.goto('/settings/index.html', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Control center' })).toBeVisible();
    await expect(page.locator('#overview-panel')).toBeVisible();
  });

  test('can navigate core tabs and render device/mode data', async ({ page }) => {
    await page.goto('/settings/index.html', { waitUntil: 'domcontentloaded' });
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
});

