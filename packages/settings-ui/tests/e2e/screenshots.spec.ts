/**
 * UI screenshot capture for UX/consistency review.
 * Not a pass/fail test — generates screenshots for manual inspection.
 * Skipped in CI because the Devices tab requires a live Homey API mock.
 */
import { test } from '@playwright/test';

test.beforeEach(() => {
  test.skip(Boolean(process.env.CI), 'Screenshots are for local review only');
});

const TABS = ['Devices', 'Modes', 'Budget', 'Usage', 'Price', 'Advanced'];

test.use({ viewport: { width: 480, height: 900 } });

test('overview tab', async ({ page }) => {
  await page.goto('/settings/index.html');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/screenshots/01-overview.png' });
});

for (const [i, tab] of TABS.entries()) {
  test(`tab: ${tab.toLowerCase()}`, async ({ page }) => {
    await page.goto('/settings/index.html');
    await page.waitForTimeout(600);
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(800);
    await page.screenshot({
      path: `test-results/screenshots/${String(i + 2).padStart(2, '0')}-${tab.toLowerCase()}.png`,
    });
  });
}

test('budget tab - scroll through expanded', async ({ page }) => {
  await page.goto('/settings/index.html');
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Budget' }).click();
  await page.waitForTimeout(600);
  // Expand only collapsibles inside the budget panel
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLDetailsElement>('#budget-panel details:not([open])')) {
      el.open = true;
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/screenshots/08a-budget-top.png' });
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/08b-budget-mid.png' });
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/08c-budget-bottom.png' });
});

test('price tab - scroll through expanded', async ({ page }) => {
  await page.goto('/settings/index.html');
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Price' }).click();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLDetailsElement>('#price-panel details:not([open])')) {
      el.open = true;
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/screenshots/09a-price-top.png' });
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/09b-price-mid.png' });
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/09c-price-bottom.png' });
});

test('advanced tab - scroll through expanded', async ({ page }) => {
  await page.goto('/settings/index.html');
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Advanced' }).click();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLDetailsElement>('#advanced-panel details:not([open])')) {
      el.open = true;
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/screenshots/10a-advanced-top.png' });
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/10b-advanced-mid.png' });
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/10c-advanced-bottom.png' });
});

test('usage tab - scroll through', async ({ page }) => {
  await page.goto('/settings/index.html');
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Usage' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/screenshots/12a-usage-top.png' });
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/12b-usage-mid.png' });
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screenshots/12c-usage-bottom.png' });
});

test('devices tab - try open device detail', async ({ page }) => {
  await page.goto('/settings/index.html');
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Devices' }).click();
  await page.waitForTimeout(800);
  // Try clicking a device name link if it exists
  const detailLink = page.locator('a.device-name, .device-row td:first-child a, [data-device-id]').first();
  if (await detailLink.count() > 0) {
    await detailLink.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'test-results/screenshots/13-device-detail.png' });
  }
});
