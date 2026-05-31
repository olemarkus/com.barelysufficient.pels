/**
 * Captures settings screenshots for the docs.
 * Skipped in CI - run locally with:
 *   npx playwright test docs-settings-screenshots.spec.ts --project=chromium-mobile-width
 * Use PELS_E2E_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome if Playwright's
 * bundled Chromium is unavailable on the local platform.
 */
import { expect, renderTest as test, type Page } from './fixtures/test';

const OUT = '../../docs/public/screenshots/settings';

test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(Boolean(process.env.CI), 'Docs settings screenshots are for local use only');
  test.skip(
    testInfo.project.name !== 'chromium-mobile-width',
    'Screenshots are pinned to chromium-mobile-width to avoid clobbering.',
  );
});

test.use({ viewport: { width: 480, height: 900 } });

const prepPage = async (page: Page) => {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
    document.querySelector<HTMLElement>('.hero')?.style.setProperty('display', 'none');
  });
  await page.waitForTimeout(200);
};

const openSettingsSection = async (page: Page, target: string) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator(`.settings-nav-card[data-settings-target="${target}"]`).click();
  await expect(page.locator(`#${target}-panel`)).toBeVisible();
  await prepPage(page);
};

const captureViewport = async (page: Page, name: string) => {
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x: 0, y: 0, width: 480, height: 720 },
  });
};

test('limits and safety', async ({ page }) => {
  await openSettingsSection(page, 'limits');
  await expect(page.locator('#limits-title')).toBeVisible();
  await captureViewport(page, 'limits-safety');
});

test('devices', async ({ page }) => {
  await openSettingsSection(page, 'devices');
  await expect(page.locator('#device-card-list')).toContainText('Living Room Heat Pump');
  await captureViewport(page, 'devices');
});

test('modes', async ({ page }) => {
  await openSettingsSection(page, 'modes');
  await expect(page.locator('#priority-list')).toContainText('Living Room Heat Pump');
  await captureViewport(page, 'modes');
});
