import { expect, renderTest as test, captureOutputDir } from './fixtures/test';
import type { StubWindow } from './stubWindow';

for (const width of [320, 480]) {
  for (const mobile of [false, true]) {
    test.describe(`${width}px ${mobile ? 'dark' : 'light'} charging sessions`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
      test.skip(({ browserName }) => browserName !== 'chromium', 'Narrow-layout inspection uses Chromium');

      test('opts in from the charging card and preserves other chargers', async ({ page }) => {
        await page.addInitScript(() => {
          (window as unknown as StubWindow).__PELS_HOMEY_STUB__ = {
            settings: {
              ev_charging_session_smoothing: { 'other-charger': true },
              ui_price_timeline: { state: 'ready', periods: [{
                startsAt: new Date().toISOString(), durationMinutes: 15, importPrice: 1, level: 'normal',
              }], priceUnit: 'kr/kWh', hasExportPrice: false,
              lines: { average: 1, cheapAtOrBelow: 0.8, expensiveFrom: 1.2 } },
            },
            apiHandlers: {
              'GET /ui_smart_task_devices': () => ({ state: 'ready', devices: [{
                deviceId: 'dev_zaptec', deviceName: 'Zaptec Go', group: 'ev_charger', kind: 'ev_soc',
                unitSymbol: '%', goalMin: 1, goalMax: 100, goalStep: 1, otherGoals: [],
                defaultGoal: 80, currentValue: 40, offersQuickTargets: true, supportsLimitLowerPriority: true,
              }] }),
            },
          };
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
        await page.locator('#devices-panel [data-device-id="dev_zaptec"] .pels-device-card__detail-button').first().click();
        const row = page.locator('#device-detail-charging-session-smoothing');
        const toggle = page.locator('#device-detail-charging-session-smoothing-enabled');
        await expect(row).toBeVisible();
        await row.scrollIntoViewIfNeeded();
        await expect(toggle).toHaveJSProperty('selected', false);
        await expect(row).toContainText('15 minutes');
        await expect(row).toContainText('5%');
        expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await row.locator('.md-switch-row__label').click();
        await expect(toggle).toHaveJSProperty('selected', true);
        const readPreference = () => page.evaluate(() => new Promise((resolve, reject) => {
          (window as unknown as StubWindow).Homey.get('ev_charging_session_smoothing', (error, value) => {
            if (error) reject(error);
            else resolve(value);
          });
        }));
        await expect.poll(readPreference).toEqual({ 'other-charger': true, dev_zaptec: true });
        await row.screenshot({ path: `${captureOutputDir('pels-ev-smoothing')}/${width}-${mobile ? 'dark' : 'light'}.png` });
        const publishPricing = (durationMinutes: number) => page.evaluate((minutes) => {
          const homey = (window as unknown as StubWindow).Homey;
          homey.__stub.setSetting('ui_price_timeline', { state: 'ready', periods: [{
            startsAt: new Date().toISOString(), durationMinutes: minutes, importPrice: 1, level: 'normal',
          }], priceUnit: 'kr/kWh', hasExportPrice: false,
          lines: { average: 1, cheapAtOrBelow: 0.8, expensiveFrom: 1.2 } });
          homey.__stub.emitHomeyEvent('prices_updated');
        }, durationMinutes);
        await publishPricing(60);
        await expect(row).toBeHidden();
        expect(await readPreference()).toEqual({ 'other-charger': true, dev_zaptec: true });
        await publishPricing(15);
        await expect(row).toBeVisible();
        await expect(toggle).toHaveJSProperty('selected', true);
        await row.locator('.md-switch-row__label').click();
        await expect.poll(readPreference).toEqual({ 'other-charger': true });
        await expect(toggle).toHaveJSProperty('selected', false);
      });
    });
  }
}
