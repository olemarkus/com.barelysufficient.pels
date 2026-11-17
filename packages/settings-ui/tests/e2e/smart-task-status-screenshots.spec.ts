import fs from 'node:fs';
import path from 'node:path';
import { captureOutputDir, expect, injectHomeyHostCss, test } from './fixtures/test';
import { openPriceAwareDevices, pushOverviewTasks, seedSecondOverviewTask } from './fixtures/smartTaskStatus';

const OUT_DIR = process.env.PELS_TASK_STATUS_OUT_DIR ?? captureOutputDir('pels-task-status-render');
const FIXED_NOW_MS = Date.UTC(2026, 10, 17, 12);

// Review captures only. Both themes retain Homey's host stylesheet, with touch
// emulation selecting PELS's mobile dark palette rather than a CSS override.
for (const width of [320, 480] as const) {
  for (const dark of [false, true]) {
    test(`task status and price confirmation at ${width}px ${dark ? 'dark' : 'light'}`, async ({
      browser, browserName, baseURL,
    }) => {
      test.skip(process.env.PELS_CAPTURE_TASK_STATUS !== '1', 'Set PELS_CAPTURE_TASK_STATUS=1 to capture.');
      test.skip(browserName !== 'chromium', 'The dark mobile capture requires Chromium touch emulation.');
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const context = await browser.newContext({
        baseURL,
        viewport: { width, height: 1800 },
        ...(dark ? { isMobile: true, hasTouch: true } : {}),
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await page.clock.setFixedTime(FIXED_NOW_MS);
        await seedSecondOverviewTask(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#plan-smart-task-row')).toHaveAttribute('data-variant', 'steady');
        await pushOverviewTasks(page, [
          { deviceId: 'dev_connected300', deviceName: 'Connected 300', state: 'awaiting_prices' },
          { deviceId: 'dev_heatpump', deviceName: 'Living Room Heat Pump', state: 'price_off' },
        ]);
        const section = page.locator('#plan-smart-task-status');
        await expect(section.locator('[data-task-device-id]')).toHaveCount(2);
        await section.scrollIntoViewIfNeeded();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ animations: 'disabled', path: path.join(OUT_DIR, `overview-${width}-${dark ? 'dark' : 'light'}.png`) });

        await openPriceAwareDevices(page);
        await page.locator('#price-aware-devices-panel md-switch').click();
        const dialog = page.locator('#price-aware-devices-panel md-dialog');
        await expect(dialog).toHaveJSProperty('open', true);
        await expect(dialog.getByRole('button', { name: 'Keep on', exact: true })).toBeVisible();
        await page.screenshot({ animations: 'disabled', path: path.join(OUT_DIR, `confirmation-${width}-${dark ? 'dark' : 'light'}.png`) });
      } finally {
        await context.close();
      }
    });
  }
}
