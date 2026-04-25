/**
 * Captures screenshots sized for the docs landing page.
 * Skipped in CI — run locally with:
 *   npx playwright test landing-screenshots.spec.ts --project=chromium-mobile-width
 */
import { test } from './fixtures/test';

const OUT = '../../docs/public/screenshots';

test.beforeEach(() => {
  test.skip(Boolean(process.env.CI), 'Landing screenshots are for local use only');
});

test.use({ viewport: { width: 480, height: 900 } });

const prepPage = async (page: import('@playwright/test').Page) => {
  // Hide the dry-run banner and top chrome so screenshots show only content
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
    document.querySelector<HTMLElement>('.hero')?.style.setProperty('display', 'none');
  });
  await page.waitForTimeout(200);
};

test('overview', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await prepPage(page);

  await page.screenshot({
    path: `${OUT}/landing-overview.png`,
    clip: { x: 0, y: 0, width: 480, height: 720 },
  });
});

test('devices', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Devices' }).click();
  await page.waitForTimeout(800);
  await prepPage(page);

  await page.screenshot({
    path: `${OUT}/landing-devices.png`,
    clip: { x: 0, y: 0, width: 480, height: 540 },
  });
});

test('usage', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Usage' }).click();
  await page.waitForTimeout(1200);
  await prepPage(page);

  // Scroll down to show the hourly chart area
  await page.evaluate(() => window.scrollBy(0, 280));
  await page.waitForTimeout(400);

  await page.screenshot({
    path: `${OUT}/landing-usage.png`,
    clip: { x: 0, y: 0, width: 480, height: 560 },
  });
});

test('price', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Price' }).click();
  await page.waitForTimeout(800);
  await prepPage(page);

  await page.screenshot({
    path: `${OUT}/landing-price.png`,
    clip: { x: 0, y: 0, width: 480, height: 540 },
  });
});
