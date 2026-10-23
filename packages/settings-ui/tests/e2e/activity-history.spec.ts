import { expect, test, injectHomeyHostCss } from './fixtures/test';

test('activity navigation, filtering and session boundaries at narrow widths in both themes', async ({ browser, browserName, baseURL }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Touch emulation uses Chromium');
  for (const width of [320, 480]) {
    for (const dark of [false, true]) {
      const context = await browser.newContext({
        baseURL, viewport: { width, height: 1100 }, isMobile: dark, hasTouch: dark,
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await page.addInitScript(() => {
          const now = Date.now();
          const entries = Array.from({ length: 55 }, (_, i) => ({
            id: `event-${i}`, deviceId: i % 2 ? 'charger' : 'heater',
            deviceName: i % 2 ? 'Car charger' : 'Hall heater',
            atMs: now - i * 60_000, recordingStartedAtMs: now - (i < 2 ? 120_000 : 86_400_000),
            stateMsg: i % 2 ? 'Limited' : 'Running', stateKind: i % 2 ? 'held' : 'active',
            stateTone: i % 2 ? 'held' : 'active', powerMsg: null,
            usageMsg: i % 2 ? '64 % · target 80 %' : '18 °C · target 22 °C',
            statusMsg: i % 2 ? 'Waiting for capacity' : '',
          }));
          const stubWindow = window as Window & { __PELS_HOMEY_STUB__?: unknown };
          stubWindow.__PELS_HOMEY_STUB__ = {
            apiHandlers: {
              'GET /ui_device_log': () => ({
                version: 2, entries, retentionDays: 7, maxEntriesPerDevice: 100, maxEntries: 1000, persistence: 'stored',
              }),
            },
          };
        });
        await page.goto('/?page=settings');
        await page.locator('[data-settings-target="activity"]').click();
        const panel = page.locator('#activity-panel');
        await expect(panel).toBeVisible();
        await expect(page).toHaveURL(/page=settings%2Factivity/);
        await expect(panel.locator('.device-log__entry')).toHaveCount(50);
        await expect(panel.locator('.device-log__session')).toHaveCount(2);
        await panel.getByRole('button', { name: 'Show older activity' }).click();
        await expect(panel.locator('.device-log__entry')).toHaveCount(55);
        const select = panel.locator('md-filled-select');
        await select.click();
        await select.getByRole('option', { name: 'Car charger', exact: true }).click();
        await expect(select.getByRole('option', { name: 'Car charger', exact: true })).toBeHidden();
        await expect(panel.locator('.device-log__entry')).toHaveCount(2);
        await expect(panel.locator('.device-log__entry').first()).toContainText('Car charger');
        await expect(panel.locator('.device-log__entry').first()).toContainText('Waiting for capacity');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await panel.screenshot({ path: testInfo.outputPath(`activity-${width}-${dark ? 'dark' : 'light'}.png`) });
        await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(panel.locator('.device-log__entry')).toHaveCount(2);
        await panel.getByRole('button', { name: 'Back to Settings' }).click();
        await expect(page.locator('#settings-panel')).toBeVisible();
      } finally {
        await context.close();
      }
    }
  }
});
