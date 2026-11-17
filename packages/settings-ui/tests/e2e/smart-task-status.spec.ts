import { renderTest as test, expect } from './fixtures/test';
import {
  openPriceAwareDevices, pushOverviewTasks, readRespondToPrices, seedSecondOverviewTask,
} from './fixtures/smartTaskStatus';

const SECTION = '#plan-smart-task-status';
const SWITCH = '#price-aware-devices-panel md-switch';

test('shows a current price-policy pause over a cached plan and clears it on recovery', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#plan-smart-task-row')).toHaveAttribute('data-variant', 'steady');
  await pushOverviewTasks(page, [{ deviceId: 'dev_connected300', deviceName: 'Connected 300', state: 'price_off' }]);
  const section = page.locator(SECTION);
  await expect(section.getByRole('heading', { name: 'Smart task status', exact: true })).toBeVisible();
  const row = section.locator('[data-task-device-id="dev_connected300"]');
  await expect(row).toHaveAttribute('data-tone', 'warn');
  await expect(row).toContainText('Respond to prices is off');
  await expect(page.locator('#plan-smart-task-row')).toHaveCount(0);

  await row.getByRole('button', { name: 'Open price-aware devices', exact: true }).click();
  await expect(page.locator('#price-aware-devices-panel')).toBeVisible();
  await expect(page).toHaveURL((url) => url.searchParams.get('page') === 'settings/price-aware-devices');

  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await pushOverviewTasks(page, [{ deviceId: 'dev_connected300', deviceName: 'Connected 300', state: 'healthy' }]);
  await expect(page.locator(SECTION)).toHaveCount(0);
  await expect(page.locator('#plan-smart-task-row')).toHaveAttribute('data-variant', 'steady');
});

test('shows tomorrow-price waiting neutrally and opens the affected task', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#plan-smart-task-row')).toHaveAttribute('data-variant', 'steady');
  await pushOverviewTasks(page, [{ deviceId: 'dev_connected300', deviceName: 'Connected 300', state: 'awaiting_prices' }]);
  const row = page.locator(`${SECTION} [data-task-device-id="dev_connected300"]`);
  await expect(row).toHaveAttribute('data-tone', 'muted');
  await expect(row).toContainText('Waiting for tomorrow’s prices');
  await expect(row).not.toContainText('Check electricity prices');
  await row.getByRole('button', { name: 'View task', exact: true }).click();
  await expect(page.locator('#deadline-plan-panel')).toBeVisible();
  await expect(page).toHaveURL(/page=deadline-plan&deviceId=dev_connected300/);
});

test('keeps each task’s reason visible and places an actionable pause before normal waiting', async ({ page }) => {
  await seedSecondOverviewTask(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#plan-smart-task-row')).toHaveAttribute('data-variant', 'steady');
  await pushOverviewTasks(page, [
    { deviceId: 'dev_connected300', deviceName: 'Connected 300', state: 'awaiting_prices' },
    { deviceId: 'dev_heatpump', deviceName: 'Living Room Heat Pump', state: 'price_off' },
  ]);
  const rows = page.locator(`${SECTION} [data-task-device-id]`);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-task-device-id', 'dev_heatpump');
  await expect(rows.first()).toContainText('Respond to prices is off');
  await expect(rows.last()).toHaveAttribute('data-tone', 'muted');
  await expect(rows.last()).toContainText('Waiting for tomorrow’s prices');
});

test('confirms disabling Respond to prices, keeps cancellation safe, and enables without a dialog', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await openPriceAwareDevices(page);
  const control = page.locator(SWITCH);
  const dialog = page.locator('#price-aware-devices-panel md-dialog');
  await expect(control).toHaveJSProperty('selected', true);
  await expect(control.locator('input')).toBeChecked();
  await expect(page.locator('#respond-to-prices-hint')).toContainText('Smart tasks also need this setting');

  await control.click();
  await expect(dialog).toHaveJSProperty('open', true);
  await expect(dialog).toContainText('Enabled Smart tasks will pause and may not be ready by their ready-by time.');
  await dialog.getByRole('button', { name: 'Keep on', exact: true }).click();
  await expect(dialog).toHaveJSProperty('open', false);
  await expect(control).toHaveJSProperty('selected', true);
  await expect(control.locator('input')).toBeChecked();
  await expect.poll(() => readRespondToPrices(page)).toBe(true);

  await control.click();
  await expect(dialog).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveJSProperty('open', false);
  await expect(control).toHaveJSProperty('selected', true);
  await expect(control.locator('input')).toBeChecked();
  await expect.poll(() => readRespondToPrices(page)).toBe(true);

  await control.click();
  await expect(dialog).toHaveJSProperty('open', true);
  await dialog.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(control).toHaveJSProperty('selected', false);
  await expect(control.locator('input')).not.toBeChecked();
  await expect.poll(() => readRespondToPrices(page)).toBe(false);
  await expect(page.locator('#respond-to-prices-hint')).toContainText('any enabled Smart tasks are paused');
  await expect(dialog).toHaveJSProperty('open', false);

  await control.click();
  await expect(control).toHaveJSProperty('selected', true);
  await expect(control.locator('input')).toBeChecked();
  await expect.poll(() => readRespondToPrices(page)).toBe(true);
  await expect(dialog).toHaveJSProperty('open', false);
});
