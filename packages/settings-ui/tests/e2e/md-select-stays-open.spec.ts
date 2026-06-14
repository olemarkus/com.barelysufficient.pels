/**
 * Regression: a Material <md-select> wrapped in a <label> collapses its menu
 * immediately on open in Firefox (the <label> re-dispatches the opening click to
 * its control, which the menu reads as an outside-click and dismisses). The
 * Power source, Advanced "Device cleanup", and Advanced "Device log" pickers were
 * the only md-selects still wrapped in a <label>; they now use <div class="field">
 * like every other select. Runs on both chromium and firefox.
 */
import { expect, test, type Page } from './fixtures/test';
import type { Locator } from '@playwright/test';

const isSelectOpen = (select: Locator): Promise<boolean> => (
  select.evaluate((el) => Boolean((el as HTMLElement & { open?: boolean }).open))
);

const emitDevicesUpdated = (page: Page) => page.evaluate(() => {
  const homey = (window as { Homey?: { __stub?: { emitHomeyEvent: (event: string, ...args: unknown[]) => void } } }).Homey;
  homey?.__stub?.emitHomeyEvent('devices_updated');
});

const gotoSettings = async (page: Page, target: string) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.locator(`.settings-nav-card[data-settings-target="${target}"]`).click();
  await page.waitForTimeout(700);
};

const expectOpensAndStays = async (page: Page, selector: string, { withTicks = false } = {}) => {
  const select = page.locator(selector);
  await select.scrollIntoViewIfNeeded();
  await select.click();
  await expect.poll(() => isSelectOpen(select), { timeout: 5000 }).toBe(true);
  for (let i = 0; i < 4; i++) {
    if (withTicks) await emitDevicesUpdated(page);
    await page.waitForTimeout(250);
  }
  expect(await isSelectOpen(select), `${selector} must stay open`).toBe(true);
};

test.describe('md-select menus stay open', () => {
  // Intentionally wide (not the 320-480px layout range): this asserts a
  // viewport-independent open/stay-open behaviour (Firefox event dispatch +
  // tick-driven rebuild), not layout, and the extra room guarantees the menu
  // has space to render fully.
  test.use({ viewport: { width: 900, height: 900 } });

  test('Power source select', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    await gotoSettings(page, 'limits');
    await expectOpensAndStays(page, '#settings-power-source');
  });

  test('Advanced Device cleanup select (under realtime ticks)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    await gotoSettings(page, 'advanced');
    await page.locator('#advanced-panel details').filter({ hasText: 'Device cleanup' }).locator('summary').click();
    await expectOpensAndStays(page, '#advanced-device-select', { withTicks: true });
  });

  test('Advanced Device log select (under realtime ticks)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    await gotoSettings(page, 'advanced');
    await page.locator('#advanced-panel details').filter({ hasText: 'Device log' }).locator('summary').click();
    await page.locator('#advanced-api-device-refresh').click();
    await page.waitForTimeout(400);
    await expectOpensAndStays(page, '#advanced-api-device-select', { withTicks: true });
  });
});
