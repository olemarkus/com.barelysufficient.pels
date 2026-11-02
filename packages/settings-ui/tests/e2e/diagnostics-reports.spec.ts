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

test('links the automatic reports and Report a problem to each other', async ({ page }, testInfo) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  const advanced = page.locator('.settings-nav-card[data-settings-target="advanced"]');
  await advanced.scrollIntoViewIfNeeded();
  await advanced.click();
  await page.locator('#advanced-panel summary', { hasText: 'Diagnostics reports' }).click();
  const reportLink = page.locator('#advanced-report-problem-link');
  await reportLink.scrollIntoViewIfNeeded();
  await page.locator('#advanced-panel').screenshot({ path: testInfo.outputPath('advanced-to-report.png') });

  await reportLink.click();
  // Back returns to Advanced, not the Settings root.
  await expect(page.locator('#report-problem-panel .pels-appbar__back')).toHaveAttribute('data-settings-target', 'advanced');
  const automatic = page.locator('[data-report-action="automatic"]');
  await expect(automatic).toBeVisible();
  await automatic.scrollIntoViewIfNeeded();
  await page.locator('#report-problem-panel').screenshot({ path: testInfo.outputPath('report-to-advanced.png') });

  await automatic.click();
  await expect(page.locator('#advanced-diagnostics-reports')).toHaveJSProperty('open', true);
  await expect(page.locator('#advanced-daily-report')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('advanced-opened.png') });
});
