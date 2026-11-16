import type { StubWindow } from './stubWindow';
import { expect, test, injectHomeyHostCss } from './fixtures/test';

test('a grid import limit below the home usage warns and keeps the saved limits on request', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await injectHomeyHostCss(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="limits"]').click();
  await page.locator('#settings-grid-import-enabled').click();
  await page.locator('#settings-grid-import-limit').evaluate((element) => {
    (element as HTMLElement & { value: string }).value = '0.1';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#settings-grid-import-usage-alert')).toBeVisible();
  await expect(page.locator('#settings-grid-import-usage-alert')).toContainText('where PELS starts reducing loads');
  const dialog = page.locator('#limits-usage-confirm-dialog');
  await expect(dialog.getByText('Save a limit below your usage?')).toBeVisible();
  await dialog.getByText('Keep saved limits').click();
  const saved = await page.evaluate(() => new Promise<unknown>((resolve) => {
    (window as unknown as StubWindow).Homey.get('grid_import_limit_kw', (_error, value) => resolve(value));
  }));
  expect(saved).not.toBe(0.1);
  await expect(page.locator('#settings-grid-import-enabled')).toHaveJSProperty('selected', false);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
