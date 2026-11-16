import type { StubWindow } from './stubWindow';
import { expect, test, injectHomeyHostCss } from './fixtures/test';

test('main fuse entered as a subscribed power saves amps per phase', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await injectHomeyHostCss(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="limits"]').click();
  await page.locator('#settings-main-fuse-enabled').click();
  await expect(page.locator('#settings-main-fuse-fields')).toBeVisible();
  await page.getByRole('radio', { name: 'kVA', exact: true }).click();
  await expect(page.locator('#settings-main-fuse-kva')).toBeVisible();
  await expect(page.locator('#settings-main-fuse-amps')).toBeHidden();
  await page.locator('#settings-main-fuse-kva').evaluate((element) => {
    (element as HTMLElement & { value: string }).value = '12';
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const get = (key: string) => page.evaluate((name) => new Promise<unknown>((resolve) => {
    (window as unknown as StubWindow).Homey.get(name, (_error, value) => resolve(value));
  }), key);
  await expect.poll(() => get('main_fuse_supply')).toBe('three_phase_neutral');
  await expect.poll(async () => Number(await get('main_fuse_amps'))).toBeCloseTo(12000 / 690, 6);
  expect(await get('main_fuse_entry_unit')).toBe('kva');
  await expect(page.locator('#settings-main-fuse-hint')).toContainText('per phase');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);

  await page.getByRole('radio', { name: 'Amps', exact: true }).click();
  await expect(page.locator('#settings-main-fuse-amps')).toHaveJSProperty('value', '17.4');
  expect(Number(await get('main_fuse_amps'))).toBeCloseTo(12000 / 690, 6);
});
