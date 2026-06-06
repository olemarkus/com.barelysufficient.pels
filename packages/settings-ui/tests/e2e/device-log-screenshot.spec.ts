/**
 * Captures the device-detail Activity log section (the device-log view).
 * Local only:
 *   PELS_CAPTURE_DEVICE_LOG=1 PELS_DEVICE_LOG_OUT_DIR=/tmp \
 *     npx playwright test device-log-screenshot.spec.ts --project=chromium-mobile-width
 */
import { expect, injectHomeyHostCss, test, type Page } from './fixtures/test';

const DEVICE_ID = 'dev_waterheater';

const seedDeviceLog = async (page: Page) => {
  await page.addInitScript((deviceId) => {
    const now = Date.now();
    const minute = 60_000;
    const payload = {
      version: 1,
      entriesByDeviceId: {
        [deviceId]: [
              {
                atMs: now - 2 * minute,
                powerMsg: 'off → on',
                stateMsg: 'Resuming',
                usageMsg: 'Measured: 0.00 kW / Expected: 2.00 kW',
                statusMsg: 'Power available again',
                stateKind: 'resuming',
                stateTone: 'resuming',
              },
              {
                atMs: now - 18 * minute,
                powerMsg: 'on → off',
                stateMsg: 'Limited',
                usageMsg: 'Measured: 0.00 kW / Expected: 2.00 kW',
                statusMsg: 'Limiting to stay within the daily budget — Turned off by PELS',
                stateKind: 'held',
                stateTone: 'held',
              },
          {
            atMs: now - 47 * minute,
            powerMsg: null,
            stateMsg: 'Running',
            usageMsg: 'Measured: 1.95 kW / Expected: 2.00 kW',
            statusMsg: 'Within budget',
            stateKind: 'active',
            stateTone: 'active',
          },
        ],
      },
    };
    const existing = (window as { __PELS_HOMEY_STUB__?: Record<string, unknown> }).__PELS_HOMEY_STUB__ ?? {};
    const apiHandlers = (existing.apiHandlers as Record<string, unknown>) ?? {};
    apiHandlers['GET /ui_device_log'] = () => payload;
    (window as { __PELS_HOMEY_STUB__?: Record<string, unknown> }).__PELS_HOMEY_STUB__ = {
      ...existing,
      apiHandlers,
    };
  }, DEVICE_ID);
};

// Take `browser` (not `page`) so no context is created until after the chromium
// guard — Firefox rejects `isMobile` at context creation, so the mobile-emulated
// context must only be built once we know we're on chromium.
test('device-log activity section', async ({ browser, browserName, baseURL }) => {
  test.skip(Boolean(process.env.CI), 'Device-log screenshot is local only');
  test.skip(!process.env.PELS_CAPTURE_DEVICE_LOG, 'Set PELS_CAPTURE_DEVICE_LOG=1 to capture.');
  test.skip(browserName !== 'chromium', 'Mobile capture needs chromium isMobile emulation (unsupported in Firefox).');

  // A manually-created context does not inherit baseURL from the page fixture,
  // so pass it explicitly or page.goto('/') has no base to resolve against.
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 480, height: 1600 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await injectHomeyHostCss(page);
    await seedDeviceLog(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
    const row = page.locator(`#devices-panel [data-device-id="${DEVICE_ID}"]`).first();
    await expect(row).toBeVisible();
    await row.locator('.pels-device-card__detail-button').click();
    await expect(page.locator('#device-detail-overlay')).toBeVisible();

    const disclosure = page.locator('#device-detail-activity-log-disclosure');
    await disclosure.locator('summary').click();
    await expect(page.locator('.device-log__entry').first()).toBeVisible();

    const outDir = process.env.PELS_DEVICE_LOG_OUT_DIR ?? '/tmp';
    await page.locator('#device-detail-activity-log-section').screenshot({
      path: `${outDir}/device-log-activity.png`,
    });
  } finally {
    await context.close();
  }
});
