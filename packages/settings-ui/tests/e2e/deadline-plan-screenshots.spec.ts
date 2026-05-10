import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from './fixtures/test';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(SCRIPT_DIR, '../../../../docs/screenshots/deadline-plan');

const openDeadlinePlan = async (page: Page) => {
  await page.goto('/deadline-plan.html?deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.plan-hero__headline')).toBeVisible();
  await expect(page.locator('.deadline-horizon-chart svg')).toBeVisible();
};

test.describe('Deadline plan screenshots', () => {
  test.skip(process.env.PELS_CAPTURE_SCREENSHOTS !== '1', 'Set PELS_CAPTURE_SCREENSHOTS=1 to regenerate.');

  test('captures the temperature variant at 480px', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await openDeadlinePlan(page);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '480.png'),
      fullPage: true,
    });
  });

  test('captures the temperature variant at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await openDeadlinePlan(page);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '320.png'),
      fullPage: true,
    });
  });
});
