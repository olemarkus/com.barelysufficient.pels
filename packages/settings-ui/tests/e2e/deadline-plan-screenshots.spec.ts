import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from './fixtures/test';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(SCRIPT_DIR, '../../../../docs/screenshots/deadline-plan');

const openDeadlinePlan = async (page: Page) => {
  await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('#deadline-plan-panel');
  await expect(panel.locator('.plan-hero__headline')).toBeVisible();
  await expect(panel.locator('.deadline-horizon-chart svg')).toBeVisible();
  // The router toggles a `.hidden` class on `#shell-nav` whenever the plan
  // panel is open, and the matching CSS rule (`#shell-nav.hidden { display:
  // none; }`) now hides it natively. Only the page-level `.hero` and the
  // global dry-run banner still need to be tucked away for the docs capture.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.hero')?.style.setProperty('display', 'none');
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
  });
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
