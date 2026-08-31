/**
 * Captures the per-home "Limits & safety" panel states for design review
 * (multi-home U3). Skipped in CI — run locally with:
 *   npx playwright test limits-per-home-screenshots.spec.ts --project=chromium-mobile-width
 * Output: ../../screenshots/ (worktree root, not committed).
 */
import { expect, test as base, injectHomeyHostCss, type Page } from './fixtures/test';
import {
  gotoApp,
  installRentalMeterDeviceList,
  pickHomeScope,
  seedRentalArea,
  seedRentalMeterSnapshot,
  seedStubSetting,
} from './fixtures/homes';

const OUT = '../../screenshots';
const WIDTHS = [480, 320] as const;
const AREA_ID = 'h_11111111';

const test = base;

test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(Boolean(process.env.CI), 'Design-review screenshots are for local use only');
  test.skip(
    testInfo.project.name !== 'chromium-mobile-width',
    'Screenshots are pinned to chromium-mobile-width to avoid clobbering.',
  );
});

type StateName = 'main-unchanged' | 'scope-bar' | 'simulation' | 'active-status';

const openLimitsPanel = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const navCard = page.locator('.settings-nav-card[data-settings-target="limits"]');
  await navCard.scrollIntoViewIfNeeded();
  await navCard.click();
  await expect(page.locator('#limits-panel')).toBeVisible();
};

const switchToArea = async (page: Page): Promise<void> => {
  await expect(page.locator('#home-scope-chip')).toBeVisible();
  await pickHomeScope(page, AREA_ID);
  await expect(page.locator('#home-limits-hard-cap')).toBeVisible();
};

const prepareState = async (page: Page, state: StateName): Promise<void> => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  if (state !== 'main-unchanged') await seedRentalArea(page);
  if (state === 'active-status') {
    await seedStubSetting(page, `capacity_limit_kw:${AREA_ID}`, 8);
    await seedStubSetting(page, `capacity_margin_kw:${AREA_ID}`, 0.3);
    await seedStubSetting(page, `capacity_dry_run:${AREA_ID}`, false);
    await seedStubSetting(page, `pels_status:${AREA_ID}`, {
      controlledKw: 2.5, uncontrolledKw: 1.5, powerKnown: true,
      devicesOff: 1, limitReason: 'hourly',
    });
  }
  if (state === 'simulation') {
    await seedStubSetting(page, `pels_status:${AREA_ID}`, {
      controlledKw: 3, uncontrolledKw: 1, powerKnown: true,
      devicesOff: 2, limitReason: 'hourly',
    });
  }
  await openLimitsPanel(page);
  if (state === 'main-unchanged') {
    // No meter areas ⇒ no scope bar, the static form is the whole panel.
    await expect(page.locator('#home-scope-chip')).toHaveCount(0);
    await expect(page.locator('#settings-limits-form')).toBeVisible();
  }
  if (state === 'scope-bar') {
    await expect(page.locator('#home-scope-chip')).toBeVisible();
    await expect(page.locator('#settings-limits-form')).toBeVisible();
  }
  if (state === 'simulation') {
    await switchToArea(page);
    await expect(page.locator('#home-limits-sim-notice')).toBeVisible();
  }
  if (state === 'active-status') {
    await switchToArea(page);
    await expect(page.locator('#home-limits-status-chip')).toHaveText('Active');
  }
};

for (const state of ['main-unchanged', 'scope-bar', 'simulation', 'active-status'] as StateName[]) {
  test(`capture ${state}`, async ({ browser, baseURL }) => {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        baseURL,
        viewport: { width, height: 900 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await prepareState(page, state);
        await page.waitForTimeout(300);
        // Full page, not the 900 px viewport: the panel runs past the fold in
        // the area states, so a clipped shot hid everything below the cap
        // fields — including the trailing note about the app-global settings.
        await page.screenshot({ path: `${OUT}/limits-${state}-${width}.png`, fullPage: true });
      } finally {
        await context.close();
      }
    }
  });
}
