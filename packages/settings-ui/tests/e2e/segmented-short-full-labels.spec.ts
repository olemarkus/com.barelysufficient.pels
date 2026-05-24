/**
 * Regression guard for the `segmented__option-label--full` / `--short`
 * dual-label pattern. The CSS hides `--short` by default (`display: none`)
 * and flips to hiding `--full` at `@media (max-width: 360px)`. If a future
 * CSS edit breaks the toggle (e.g. removes the default `display: none` or
 * the media query), both spans would render concurrently and the button
 * would show "YesterdayYest." as one run. Two viewport probes pin the
 * exclusivity at the breakpoint extremes the app actually supports
 * (480 px = default mobile shell, 320 px = narrow shell).
 *
 * The CSS hides the inactive span via `display: none`, so Playwright's
 * `toBeHidden()` / `toBeVisible()` predicates match the runtime behavior
 * directly (no need to introspect computed styles).
 */
import { expect, test, type Page } from './fixtures/test';

const openBudgetTab = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.getByRole('tab', { name: 'Budget' }).click();
  await expect(page.locator('#budget-redesign-surface')).toBeVisible();
};

// Pin to a single option ("Yesterday" / "Yest.") so each probe inspects
// exactly one full/short pair, keeping the assertion narrow.
const fullLabel = (page: Page) =>
  page.locator('.segmented__option-label--full', { hasText: 'Yesterday' });
const shortLabel = (page: Page) =>
  page.locator('.segmented__option-label--short', { hasText: 'Yest.' });

test.describe('segmented dual-label exclusivity', () => {
  test('480 px shows --full and hides --short on the Budget day picker', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await openBudgetTab(page);

    await expect(fullLabel(page)).toBeVisible();
    await expect(shortLabel(page)).toBeHidden();
  });

  test('320 px shows --short and hides --full on the Budget day picker', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await openBudgetTab(page);

    await expect(shortLabel(page)).toBeVisible();
    await expect(fullLabel(page)).toBeHidden();
  });
});
