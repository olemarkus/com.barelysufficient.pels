/**
 * UX walkthrough of the Budget → Adjust → Preview → Apply flow.
 * Captures screenshots at each step for design review and asserts the
 * Material 3 quick-win polish (sticky CTA, kWh range hint, quantified
 * comparison delta, Undo snackbar).
 *
 * Run locally with:
 *   npx playwright test budget-adjust-ux --project=chromium-mobile-width
 *
 * Screenshots land in /tmp/pels-budget-ux/.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from './fixtures/test';

const OUT_DIR = '/tmp/pels-budget-ux';

test.use({ viewport: { width: 480, height: 900 } });

test.beforeAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
});

const shot = async (page: Page, name: string, opts: { fullPage?: boolean } = {}) => {
  await page.screenshot({
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: opts.fullPage ?? true,
  });
};

const stickyOffsetFromViewportBottom = async (page: Page): Promise<number> => (
  page.locator('#budget-redesign-adjust-view .budget-redesign-actions').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return window.innerHeight - rect.bottom;
  })
);

test('budget adjust → preview → apply walkthrough', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-mobile-width',
    'Screenshot walkthrough is pinned to chromium-mobile-width.',
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tablist')).toBeVisible();

  // 1. Land on overview, then go to Budget tab.
  await page.getByRole('tab', { name: 'Budget' }).click();
  await expect(page.locator('#budget-panel')).toBeVisible();
  await expect(page.locator('#budget-redesign-surface')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, '01-budget-plan');

  // 2. Switch to the Adjust local view.
  await page.getByRole('button', { name: 'Adjust', exact: true }).click();
  await expect(page.locator('#budget-redesign-adjust-view')).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, '02-adjust-clean');

  // 2a. The kWh helper text shows the supported range.
  const hintRange = page.locator('.field__hint-range').first();
  await expect(hintRange).toContainText('20');
  await expect(hintRange).toContainText('360');

  // 2b. Planning behavior is expanded by default.
  const planningBehavior = page.locator('details.budget-planning-behavior');
  await expect(planningBehavior).toHaveAttribute('open', '');

  // 3. Edit the daily budget kWh — bump from default to 45.
  const kwhField = page.locator('#budget-redesign-kwh');
  await kwhField.scrollIntoViewIfNeeded();
  await kwhField.evaluate((el: HTMLElement & { value?: string }) => {
    el.value = '45';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);

  // 4. Switch managed device flexibility to High (0.85).
  const flexGroup = page.locator('#budget-redesign-price-flex-share');
  await flexGroup.scrollIntoViewIfNeeded();
  await flexGroup.getByRole('button', { name: 'High' }).click();
  await page.waitForTimeout(150);

  await shot(page, '03-adjust-dirty');

  // 5. Sticky actions bar is anchored to the viewport bottom while in Adjust.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  const offsetAfterScroll = await stickyOffsetFromViewportBottom(page);
  expect(Math.abs(offsetAfterScroll)).toBeLessThan(12);

  // 6. Preview changes.
  const previewBtn = page.locator('#budget-redesign-preview');
  await expect(previewBtn).toBeVisible();
  await previewBtn.click();

  // Wait for the comparison section to appear (status -> 'pending').
  await expect(page.locator('#budget-redesign-comparison')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#budget-redesign-apply')).toBeVisible();

  // 6a. The daily-budget diff row shows a quantified delta in parentheses.
  await expect(page.locator('.budget-comparison__delta')).toContainText('25');

  await page.waitForTimeout(600);
  await shot(page, '04-preview-pending');

  // Scroll to the comparison charts for a focused screenshot.
  await page.locator('#budget-redesign-comparison').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await shot(page, '05-preview-comparison');

  // 7. Apply.
  await page.locator('#budget-redesign-apply').click();
  // After apply, comparison block should disappear and status returns to clean.
  await expect(page.locator('#budget-redesign-comparison')).toHaveCount(0, { timeout: 5000 });

  // 7a. M3 snackbar shows bottom-centered with an Undo action.
  const toast = page.locator('#toast.show');
  await expect(toast).toBeVisible({ timeout: 2000 });
  const horizontalCentering = await toast.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    return Math.abs(window.innerWidth / 2 - centerX);
  });
  expect(horizontalCentering).toBeLessThan(2);

  const undoBtn = page.locator('.toast__action');
  await expect(undoBtn).toHaveText('Undo');
  await shot(page, '06-after-apply');

  // 7b. Undo reverts the daily budget back to the original (20).
  await undoBtn.click();
  await expect(kwhField).toHaveJSProperty('value', '20', { timeout: 5000 });

  // 8. Switch back to Plan to confirm new state.
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.waitForTimeout(500);
  await shot(page, '07-plan-after-apply');
});

/**
 * Regression guard for the Plan/Adjust segmented control: Homey injects a host
 * stylesheet in the settings WebView and the previous single-class selector
 * (`.segmented__option[aria-pressed="true"]`) lost the cascade fight, so the
 * selected option rendered identically to the unselected one. The CSS now uses
 * a `.segmented` parent + duplicate-attribute trick to win specificity without
 * `!important`. This test asserts the computed selected vs unselected swatches
 * actually differ — guarding against any future host-CSS regression.
 */
test('Budget Plan/Adjust segmented: selected option is visually distinct', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.getByRole('tab', { name: 'Budget' }).click();
  await expect(page.locator('#budget-redesign-surface')).toBeVisible();

  const planBtn = page.getByRole('button', { name: 'Plan', exact: true });
  const adjustBtn = page.getByRole('button', { name: 'Adjust', exact: true });

  // Plan is the default selected option.
  await expect(planBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(adjustBtn).toHaveAttribute('aria-pressed', 'false');

  const readBackground = (locator: typeof planBtn) => locator.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );

  const selectedBg = await readBackground(planBtn);
  const unselectedBg = await readBackground(adjustBtn);

  // Selected must render a real (non-transparent) tonal fill that differs
  // from the unselected sibling's background.
  expect(selectedBg).not.toBe('rgba(0, 0, 0, 0)');
  expect(selectedBg).not.toBe(unselectedBg);
});
