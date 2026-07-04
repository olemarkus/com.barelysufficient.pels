/**
 * Settings → "Daily budget" deep link into the Budget tab's Adjust view.
 *
 * The nav row carries `data-settings-target="budget-adjust"` — a virtual
 * target that opens the Budget panel with the Adjust view active. The editor
 * reads as a Settings sub-page: the shell-nav keeps "Settings" lit (no
 * teleport to the Budget tab) and the exit is the shared `.pels-appbar` back
 * arrow (not a trailing "Done"), matching the eight sibling settings
 * sub-pages. Unsaved edits arm a two-step discard confirm (a warning-tinted
 * `.confirming` glyph — the icon-only equivalent of "Tap again to discard")
 * before any exit.
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

// The Daily-budget editor's exit affordance: the shared app-bar back arrow.
const backArrow = (page: Page) => page.locator('#budget-panel .pels-appbar__back');

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
  test('opens Budget → Adjust and the back arrow returns to Settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openDailyBudgetFromSettings(page);

    await expect(page.locator('#budget-panel')).toBeVisible();
    await expect(page.locator('#budget-redesign-adjust-view')).toBeVisible();
    // No boxed hero + trailing Done: the editor renders the sibling app-bar row.
    await expect(page.locator('#budget-redesign-mode-toggle')).toHaveCount(0);
    await expect(backArrow(page)).toBeVisible();
    // The shell-nav indicator stays on "Settings" — the Daily budget editor is
    // a Settings sub-page, so opening it must not read as a jump to the Budget
    // tab.
    await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Budget' })).toHaveAttribute('aria-selected', 'false');

    await backArrow(page).click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    await expect(page.locator('#budget-panel')).toBeHidden();
  });

  test('unsaved edits arm a discard confirm on the back arrow before returning to Settings', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openDailyBudgetFromSettings(page);
    await expect(page.locator('#budget-redesign-adjust-view')).toBeVisible();

    const kwhField = page.locator('#budget-redesign-kwh');
    const originalKwh = await kwhField.evaluate(
      (el) => (el as HTMLElement & { value?: string }).value ?? '',
    );
    await setKwhDraft(page, '30');

    // First back-arrow tap arms the confirm instead of silently discarding.
    await backArrow(page).click();
    await expect(backArrow(page)).toHaveClass(/confirming/);
    await expect(page.locator('#settings-panel')).toBeHidden();

    // Second tap discards the draft and completes the return to Settings.
    await backArrow(page).click();
    await expect(page.locator('#settings-panel')).toBeVisible();

    // Re-entering shows the original value — the edit was discarded.
    await openDailyBudgetFromSettings(page);
    await expect(page.locator('#budget-redesign-kwh')).toHaveJSProperty('value', originalKwh);
  });

  test('arrival with the budget disabled pins Adjust and the back arrow still returns to Settings', async ({ page }) => {
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

    // With the feature off the pinned Adjust view has no plan to return to, but
    // the back arrow is the always-active exit — returning to Settings always
    // works — so it stays present (unlike the plan view's disabled Done).
    await expect(backArrow(page)).toBeVisible();
    await backArrow(page).click();
    await expect(page.locator('#settings-panel')).toBeVisible();
  });
});
