import { expect, test } from './fixtures/test';
import {
  gotoApp,
  installRentalMeterDeviceList,
  seedRentalArea,
  seedRentalMeterSnapshot,
} from './fixtures/homes';
import type { Page } from './fixtures/test';

/**
 * Honest not-supported states (multi-home PR 8c, locked decisions 1/3/4).
 *
 * Surfaces that do NOT follow the shell's home picker say so once a meter
 * area is in use: the Budget tab carries a Main-home scope line, the Smart
 * tasks page a Main-only notice, and the Simulation-mode settings page a note
 * naming the per-area control on Limits & safety. Each claim has a
 * single-home contrast case proving the pre-multi-home render is unchanged.
 */

const seedActiveArea = async (page: Page): Promise<void> => {
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  // The scope bar appearing on the (initially shown) Overview proves the
  // shell's roster refresh has landed — the honest lines read that roster, so
  // asserting them before it settles would race the `ui_homes` fetch.
  await expect(page.locator('#home-scope-chip')).toBeVisible();
};

test.describe('honest scope lines once a meter area is in use', () => {
  test('the Budget tab says the daily budget covers the Main home', async ({ page }) => {
    await installRentalMeterDeviceList(page);
    await gotoApp(page);
    await seedActiveArea(page);

    await page.getByRole('tab', { name: 'Budget' }).click();
    const line = page.locator('#budget-home-scope-line');
    await expect(line).toBeVisible();
    await expect(line).toContainText('Main home');
  });

  test('the Smart tasks page says smart tasks run on Main home devices', async ({ page }) => {
    await installRentalMeterDeviceList(page);
    await gotoApp(page);
    await seedActiveArea(page);

    await page.getByRole('tab', { name: 'Smart tasks' }).click();
    const notice = page.locator('#deadlines-home-scope-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Smart tasks run on Main home devices.');
  });

  test('the Simulation-mode page names the per-area control on Limits & safety', async ({ page }) => {
    await installRentalMeterDeviceList(page);
    await gotoApp(page);
    await seedActiveArea(page);

    await page.getByRole('tab', { name: 'Settings' }).click();
    const navCard = page.locator('.settings-nav-card[data-settings-target="simulation"]');
    await navCard.scrollIntoViewIfNeeded();
    await navCard.click();
    await expect(page.locator('#simulation-panel')).toBeVisible();
    const note = page.locator('#simulation-home-scope-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('“Control devices in this area”');
  });
});

test.describe('single-home installs render no scope claims', () => {
  test('Budget, Smart tasks, and Simulation mode carry no multi-home DOM', async ({ page }) => {
    await gotoApp(page);

    await page.getByRole('tab', { name: 'Budget' }).click();
    // The header proves the Budget surface has rendered (the scope line, when
    // present, is its immediate sibling), so the zero-count below asserts a
    // real absence rather than a not-yet-rendered panel.
    await expect(page.locator('#budget-redesign-surface .plan-hero, #budget-redesign-surface .pels-hero').first())
      .toBeVisible();
    await expect(page.locator('#budget-home-scope-line')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Smart tasks' }).click();
    await expect(page.locator('#deadlines-list-root .pels-hero').first()).toBeVisible();
    await expect(page.locator('#deadlines-home-scope-notice')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Settings' }).click();
    const navCard = page.locator('.settings-nav-card[data-settings-target="simulation"]');
    await navCard.scrollIntoViewIfNeeded();
    await navCard.click();
    await expect(page.locator('#simulation-panel')).toBeVisible();
    await expect(page.locator('#simulation-home-scope-note')).toBeHidden();
  });
});
