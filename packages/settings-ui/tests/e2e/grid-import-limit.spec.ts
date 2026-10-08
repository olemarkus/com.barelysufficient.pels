import type { StubWindow } from './stubWindow';
import { expect, test, injectHomeyHostCss } from './fixtures/test';

for (const theme of ['light', 'dark'] as const) {
  test(`grid import limit is discoverable and independently persisted in ${theme}`, async ({ browser, baseURL, browserName, viewport }) => {
    test.skip(theme === 'dark' && browserName === 'firefox', 'Touch-theme capture runs in Chromium');
    const context = await browser.newContext({
      baseURL,
      viewport: viewport ?? { width: 480, height: 900 },
      ...(theme === 'dark' ? { isMobile: true, hasTouch: true } : {}),
    });
    try {
      const page = await context.newPage();
      await injectHomeyHostCss(page);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Settings' }).click();
      const limits = page.locator('.settings-nav-card[data-settings-target="limits"]');
      await expect(limits).toContainText('Grid import');
      await limits.click();
      await expect(page.locator('#settings-grid-import-field')).toBeHidden();
      const grid = page.locator('#settings-grid-import-enabled');
      await grid.click();
      await expect(page.locator('#settings-grid-import-field')).toBeVisible();
      await page.locator('#settings-grid-import-limit').evaluate((element) => {
        (element as HTMLElement & { value: string }).value = '3.3';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await expect.poll(() => page.evaluate(() => new Promise<unknown>((resolve) => {
        (window as unknown as StubWindow).Homey.get('grid_import_enabled', (_error, value) => resolve(value));
      }))).toBe(true);
      await page.locator('#settings-capacity-enabled').click();
      await expect(page.locator('#settings-capacity-fields')).toBeHidden();
      await expect.poll(() => page.evaluate(() => new Promise<unknown>((resolve) => {
        (window as unknown as StubWindow).Homey.get('capacity_enabled', (_error, value) => resolve(value));
      }))).toBe(false);
      await expect(grid).toHaveJSProperty('selected', true);
      await expect(page.locator('#settings-grid-import-hint')).toContainText('3.13 kW');
      await expect(page.locator('#limits-panel')).toContainText('Temporary overshoot');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await grid.click();
      await expect.poll(() => page.evaluate(() => new Promise<unknown>((resolve) => {
        (window as unknown as StubWindow).Homey.get('grid_import_enabled', (_error, value) => resolve(value));
      }))).toBe(false);
      const savedThreshold = await page.evaluate(() => new Promise<unknown>((resolve) => {
        (window as unknown as StubWindow).Homey.get('grid_import_limit_kw', (_error, value) => resolve(value));
      }));
      expect(savedThreshold).toBe(3.3);
    } finally {
      await context.close();
    }
  });
}
