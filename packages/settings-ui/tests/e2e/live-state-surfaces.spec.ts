/**
 * Live state where users look for it (2026-07 coherence train, PR-5):
 * exception-only chips on the Settings-hub nav cards, and the device-detail
 * one-line live status row.
 */
import { expect } from '@playwright/test';
import { renderTest as test } from './fixtures/test';

test('hub chips: simulation On shows while active and clears when turned off', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  const simChip = page.locator('#settings-nav-chip-simulation');
  // The default fixture boots with simulation on.
  await expect(simChip).toBeVisible();
  await expect(simChip).toHaveText('On');
  // The prices feed is healthy in the fixture — exception chip stays hidden.
  await expect(page.locator('#settings-nav-chip-prices')).toBeHidden();

  // Turning simulation off (the banner's inline action) clears the chip.
  await page.locator('#simulation-disable-button').click();
  await expect(simChip).toBeHidden();
});

test('hub chips: daily budget Off chip tracks the enabled setting', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  const budgetChip = page.locator('#settings-nav-chip-budget');
  const initiallyEnabled = await page.evaluate(() => (
    (window as unknown as { Homey: { __stub: { getSetting: (k: string) => unknown } } })
      .Homey.__stub.getSetting('daily_budget_enabled') === true
  ));
  if (initiallyEnabled) await expect(budgetChip).toBeHidden();

  await page.evaluate(() => {
    const homey = (window as unknown as {
      Homey: { __stub: { setSetting: (k: string, v: unknown) => void; emitSettingsSet: (k: string) => void } };
    }).Homey;
    homey.__stub.setSetting('daily_budget_enabled', false);
    homey.__stub.emitSettingsSet('daily_budget_enabled');
  });
  await expect(budgetChip).toBeVisible();
  await expect(budgetChip).toHaveText('Off');
});

test('device detail opens with the live status row matching the plan card', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  // Open the heat pump's detail from its Overview card (running at 1.2 kW in
  // the fixture; simulation renders the factual state word).
  await page.locator('#plan-cards [data-device-id="dev_heatpump"]').click();
  const row = page.locator('#device-detail-live-status');
  await expect(row).toBeVisible();
  await expect(page.locator('#device-detail-live-state')).toHaveText('Running');
  await expect(page.locator('#device-detail-live-power')).toHaveText('1.2 kW');

  // Closing the overlay retires the row so the next open never flashes a
  // stale device's status.
  await page.locator('#device-detail-close').click();
  await expect(row).toBeHidden();
});
