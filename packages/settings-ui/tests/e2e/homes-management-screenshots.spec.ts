/**
 * Captures the "Multiple meters" panel states for design review.
 * Skipped in CI — run locally with:
 *   npx playwright test homes-management-screenshots.spec.ts --project=chromium-mobile-width
 * Output: ../../screenshots/ (worktree root, not committed).
 */
import { expect, test as base, injectHomeyHostCss, type Page } from './fixtures/test';
import {
  gotoApp,
  installDegradedHomesPayload,
  installRentalMeterDeviceList,
  openHomesPanel,
  seedRentalArea,
  seedRentalMeterSnapshot,
  seedStubSetting,
  seedUtilityMeterSnapshot,
} from './fixtures/homes';

const OUT = '../../screenshots';

// Dark theme is gated on the pointer (coarse/touch ⇒ dark) — every capture
// context is mobile+touch, at the two supported widths.
const WIDTHS = [480, 320] as const;

const test = base;

test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(Boolean(process.env.CI), 'Design-review screenshots are for local use only');
  test.skip(
    testInfo.project.name !== 'chromium-mobile-width',
    'Screenshots are pinned to chromium-mobile-width to avoid clobbering.',
  );
});

type StateName = 'empty' | 'list' | 'create' | 'warning' | 'notice' | 'degraded' | 'confirm' | 'hub-card';

const prepareState = async (page: Page, state: StateName): Promise<void> => {
  if (state === 'degraded') await installDegradedHomesPayload(page);
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  if (state === 'warning') await seedUtilityMeterSnapshot(page);
  if (state === 'list' || state === 'warning' || state === 'notice' || state === 'confirm') {
    await seedRentalArea(page);
  }
  if (state === 'notice') await seedStubSetting(page, 'power_source', 'homey_energy');
  if (state === 'hub-card') {
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('.settings-nav-card[data-settings-target="homes"]')).toBeVisible();
    return;
  }
  await openHomesPanel(page);
  if (state === 'empty') {
    await expect(page.locator('#homes-empty-explainer')).toBeVisible();
  }
  if (state === 'list') {
    await expect(page.locator('.homes-settings__row')).toHaveCount(1);
  }
  if (state === 'create') {
    await page.locator('#homes-add-button').click();
    await page.selectOption('#homes-meter-select', 'dev_rental_meter');
    await expect(page.locator('#homes-zone-select')).toHaveValue('z_rental');
    await expect(page.locator('#homes-name-input')).toHaveValue('Rental unit');
  }
  if (state === 'warning') {
    await page.locator('#homes-add-button').click();
    await page.selectOption('#homes-meter-select', 'dev_utility_meter');
    await page.selectOption('#homes-zone-select', 'z_living');
    await expect(page.locator('#homes-editor')).toContainText('You can still save');
  }
  if (state === 'notice') {
    await expect(page.locator('#homes-main-meter-notice')).toBeVisible();
  }
  if (state === 'degraded') {
    await expect(page.locator('#homes-panel')).toContainText('can’t safely change meter areas');
  }
  if (state === 'confirm') {
    await page.locator('.homes-settings__row md-text-button', { hasText: 'Remove' }).click();
    await expect(page.locator('.homes-settings__confirm')).toBeVisible();
  }
};

for (const state of [
  'empty', 'list', 'create', 'warning', 'notice', 'degraded', 'confirm', 'hub-card',
] as StateName[]) {
  test(`capture ${state}`, async ({ browser, baseURL }) => {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        baseURL,
        viewport: { width, height: 900 },
        // Touch (coarse pointer, no hover) flips PELS to the dark theme.
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await prepareState(page, state);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/homes-${state}-${width}.png` });
      } finally {
        await context.close();
      }
    }
  });
}
