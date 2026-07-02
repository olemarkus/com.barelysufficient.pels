/**
 * Guard for the Budget day-picker labels: the day switcher shows the full
 * "Yesterday" / "Today" / "Tomorrow" words at both the default (480 px) and the
 * narrow (320 px) shell — never a period-abbreviated "Yest." / "Tom." form,
 * which reads as a truncation. (The `segmented__option-label--full` /
 * `--short` dual-label CSS mechanism still exists for controls that opt in;
 * the day picker deliberately does not, so its labels stay whole words.)
 */
import { expect, test, type Page } from './fixtures/test';

const openBudgetTab = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.getByRole('tab', { name: 'Budget' }).click();
  await expect(page.locator('#budget-redesign-surface')).toBeVisible();
};

const dayOption = (page: Page, name: string) =>
  page.locator('#budget-redesign-surface .segmented__option', { hasText: name });

test.describe('Budget day picker labels', () => {
  for (const width of [480, 320]) {
    test(`shows full day names (no "Yest." / "Tom.") at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openBudgetTab(page);

      await expect(dayOption(page, 'Yesterday')).toBeVisible();
      await expect(dayOption(page, 'Tomorrow')).toBeVisible();
      // The period-abbreviated forms must never render.
      await expect(
        page.locator('#budget-redesign-surface .segmented__option', { hasText: /Yest\.|Tom\./ }),
      ).toHaveCount(0);
    });
  }
});
