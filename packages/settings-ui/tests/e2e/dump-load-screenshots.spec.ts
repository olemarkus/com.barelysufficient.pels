import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type Page } from './fixtures/test';

// Review-harness captures for the "Run on solar surplus" dump-load rung: the
// device-detail toggle row and the held Overview card, at 360 px wide in the
// DARK (touch) theme. Not a CI assertion — skipped unless
// PELS_CAPTURE_DUMP_LOAD=1; writes to PELS_DUMP_LOAD_OUT_DIR (or the OS temp
// dir) so it never clobbers committed docs screenshots.
//
//   PELS_CAPTURE_DUMP_LOAD=1 PELS_DUMP_LOAD_OUT_DIR=... \
//     npx playwright test dump-load-screenshots --project=chromium-mobile-width
const OUT_DIR = process.env.PELS_DUMP_LOAD_OUT_DIR ?? path.join(os.tmpdir(), 'pels-dump-load-shots');

test.describe('dump-load screenshots (360 dark)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(process.env.PELS_CAPTURE_DUMP_LOAD !== '1', 'Capture harness — run explicitly');
    // The dark theme needs isMobile (touch), which Firefox rejects.
    test.skip(browserName !== 'chromium', 'Dark (touch) capture is chromium-only');
  });

  const darkPage = async (browser: Parameters<Parameters<typeof test>[2]>[0]['browser'], baseURL?: string) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 360, height: 1200 },
      // Touch (coarse pointer / no hover) is what flips PELS to the dark theme.
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    return { context, page };
  };

  const openPoolPumpDetail = async (page: Page) => {
    await page.getByRole('tab', { name: 'Settings' }).tap();
    await page.locator('.settings-nav-card[data-settings-target="devices"]').tap();
    const row = page.locator('#devices-panel [data-device-id="dev_poolpump"]').first();
    await row.locator('.pels-device-card__detail-button').tap();
    await page.locator('#device-detail-setup-section summary').tap();
    await page.waitForTimeout(300);
  };

  test('device-detail toggle at 360 dark', async ({ browser, baseURL }) => {
    const { context, page } = await darkPage(browser, baseURL);
    try {
      await openPoolPumpDetail(page);
      const row = page.locator('#device-detail-dump-load-row');
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.locator('#device-detail-setup-section').screenshot({
        path: path.join(OUT_DIR, 'dump-load-toggle.360-dark.png'),
      });
    } finally {
      await context.close();
    }
  });

  test('held Overview card at 360 dark', async ({ browser, baseURL }) => {
    const { context, page } = await darkPage(browser, baseURL);
    try {
      const card = page.locator('.plan-card[data-device-id="dev_poolpump"]').first();
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await card.screenshot({ path: path.join(OUT_DIR, 'dump-load-held-card.360-dark.png') });
    } finally {
      await context.close();
    }
  });
});
