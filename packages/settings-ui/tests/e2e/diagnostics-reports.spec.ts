import type { StubWindow } from './stubWindow';
import { expect, test } from './fixtures/test';

const readSetting = (page: import('@playwright/test').Page, key: string) => page.evaluate((name) => (
  new Promise<unknown>((resolve) => {
    (window as unknown as StubWindow).Homey.get(name, (_error, value) => resolve(value));
  })), key);

test('turns the daily report and reports on specific events on separately', async ({ page }, testInfo) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  const advanced = page.locator('.settings-nav-card[data-settings-target="advanced"]');
  await advanced.scrollIntoViewIfNeeded();
  await advanced.click();
  await page.locator('#advanced-panel summary', { hasText: 'Diagnostics reports' }).click();

  const daily = page.locator('#advanced-daily-report');
  const events = page.locator('#advanced-event-reports');
  await expect(daily).toBeVisible();
  await expect(events).toBeVisible();
  await expect(events).toHaveJSProperty('disabled', false);
  await expect(events).toHaveJSProperty('selected', false);
  await expect(page.locator('#advanced-event-reports-label')).toHaveText('Send a report on specific events');
  await events.scrollIntoViewIfNeeded();
  await page.locator('#advanced-panel').screenshot({ path: testInfo.outputPath('diagnostics-reports.png') });

  await events.click();
  await expect.poll(() => readSetting(page, 'event_diagnostics_reports')).toBe(true);
  expect(await readSetting(page, 'daily_diagnostics_report')).not.toBe(true);
  await daily.click();
  await expect.poll(() => readSetting(page, 'daily_diagnostics_report')).toBe(true);
});
