/**
 * Settings → "Daily budget" deep link into the Budget tab's Adjust view.
 *
 * The nav row carries `data-settings-target="budget-adjust"` — a virtual
 * target that opens the Budget panel with the Adjust view active; the
 * header's Done button then routes back to the Settings panel
 * (referrer-aware return). Unsaved edits arm a two-step "Click again to
 * discard" confirm before any exit.
 */
import { expect, test, type Page } from './fixtures/test';

const openDailyBudgetFromSettings = async (page: Page) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const row = page.locator('.settings-nav-card[data-settings-target="budget-adjust"]');
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await row.click();
};

const setKwhDraft = async (page: Page, value: string) => {
  const kwhField = page.locator('#budget-redesign-kwh');
  await expect(kwhField).toBeVisible();
  await kwhField.evaluate((el, v) => {
    const target = el as HTMLElement & { value?: string };
    target.value = v;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

test.describe('Settings → Daily budget deep link', () => {
  test('opens Budget → Adjust and Done returns to Settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openDailyBudgetFromSettings(page);

    await expect(page.locator('#budget-panel')).toBeVisible();
    await expect(page.locator('#budget-redesign-adjust-view')).toBeVisible();
    // The shell-nav indicator moves to Budget — Adjust is the Budget tab's
    // canonical surface, the Settings row is just a second way in.
    await expect(page.getByRole('tab', { name: 'Budget' })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    await expect(page.locator('#budget-panel')).toBeHidden();
  });

  test('Done with unsaved edits arms a discard confirm before returning to Settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openDailyBudgetFromSettings(page);
    await expect(page.locator('#budget-redesign-adjust-view')).toBeVisible();

    const kwhField = page.locator('#budget-redesign-kwh');
    const originalKwh = await kwhField.evaluate(
      (el) => (el as HTMLElement & { value?: string }).value ?? '',
    );
    await setKwhDraft(page, '30');

    // First Done click arms the confirm instead of silently discarding.
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const confirmButton = page.getByRole('button', { name: 'Click again to discard' });
    await expect(confirmButton).toBeVisible();
    await expect(page.locator('#settings-panel')).toBeHidden();

    // Second click discards the draft and completes the return to Settings.
    await confirmButton.click();
    await expect(page.locator('#settings-panel')).toBeVisible();

    // Re-entering shows the original value — the edit was discarded.
    await openDailyBudgetFromSettings(page);
    await expect(page.locator('#budget-redesign-kwh')).toHaveJSProperty('value', originalKwh);
  });

  test('arrival with the budget disabled pins Adjust and Done still returns to Settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      (window as unknown as {
        Homey: { set: (key: string, value: unknown, cb: (error?: Error | null) => void) => void };
      }).Homey.set('daily_budget_enabled', false, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    }));

    await openDailyBudgetFromSettings(page);
    await expect(page.locator('#budget-redesign-adjust-view')).toBeVisible();

    // With the feature off the header Done is normally disabled (pinned
    // Adjust has no plan view to return to) — but a Settings-initiated
    // session keeps it enabled because returning to Settings always works.
    const done = page.getByRole('button', { name: 'Done', exact: true });
    await expect(done).toBeVisible();
    await expect(done).not.toHaveJSProperty('disabled', true);

    await done.click();
    await expect(page.locator('#settings-panel')).toBeVisible();
  });
});
