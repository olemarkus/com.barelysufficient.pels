/**
 * Captures the Meter Areas (multi-home) screenshots for the docs page
 * `docs/meter-areas.md`. Skipped in CI - run locally with:
 *   npx playwright test docs-meter-areas-screenshots.spec.ts --project=chromium-mobile-width
 * Use PELS_E2E_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome if Playwright's
 * bundled Chromium is unavailable on the local platform.
 *
 * Reuses the homes stub fixtures (the same ones the design-review specs use),
 * seeds a single "Rental unit" meter area, and writes committed PNGs to
 * docs/public/screenshots/meter-areas/. Mobile + touch flips PELS to the dark
 * theme; the default deviceScaleFactor of 1 keeps the doc images crisp at the
 * intended mobile resolution.
 */
import { expect, test as base, injectHomeyHostCss, type Page } from './fixtures/test';
import {
  gotoApp,
  installRentalMeterDeviceList,
  openHomesPanel,
  seedRentalArea,
  seedRentalMeterSnapshot,
  seedStubSetting,
} from './fixtures/homes';

const OUT = '../../docs/public/screenshots/meter-areas';
const WIDTH = 480;
const HEIGHT = 900;
const AREA_ID = 'h_11111111';

const test = base;

test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(Boolean(process.env.CI), 'Docs screenshots are for local use only');
  test.skip(
    testInfo.project.name !== 'chromium-mobile-width',
    'Screenshots are pinned to chromium-mobile-width to avoid clobbering.',
  );
});

const openLimitsPanel = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const navCard = page.locator('.settings-nav-card[data-settings-target="limits"]');
  await navCard.scrollIntoViewIfNeeded();
  await navCard.click();
  await expect(page.locator('#limits-panel')).toBeVisible();
};

const switchToArea = async (page: Page): Promise<void> => {
  await expect(page.locator('#home-limits-home-select')).toBeVisible();
  await page.selectOption('#home-limits-home-select', AREA_ID);
  await expect(page.locator('#home-limits-hard-cap')).toBeVisible();
};

type Shot = 'list' | 'editor' | 'limits-simulation' | 'limits-active';

const prepareShot = async (page: Page, shot: Shot): Promise<void> => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  // The editor shot is a CLEAN create (no pre-existing area) so the rental
  // meter is still free and its zone/name auto-suggest; every other shot needs
  // the configured "Rental unit" area to exist.
  if (shot !== 'editor') await seedRentalArea(page);

  if (shot === 'list' || shot === 'editor') {
    if (shot === 'list') {
      // Give Main its own meter so the (separate) whole-home-meter nudge stays
      // out of this "here is a configured area" shot; it has its own doc section.
      await seedStubSetting(page, 'homey_energy_meter_device_id', 'dev_main_meter');
    }
    await openHomesPanel(page);
    if (shot === 'list') {
      await expect(page.locator('.homes-settings__row')).toHaveCount(1);
      return;
    }
    await page.locator('#homes-add-button').click();
    await page.selectOption('#homes-meter-select', 'dev_rental_meter');
    await expect(page.locator('#homes-zone-select')).toHaveValue('z_rental');
    await expect(page.locator('#homes-name-input')).toHaveValue('Rental unit');
    return;
  }

  // Per-home Limits & safety, with the meter area selected.
  await seedStubSetting(page, `capacity_limit_kw:${AREA_ID}`, 8);
  await seedStubSetting(page, `capacity_margin_kw:${AREA_ID}`, 0.3);
  if (shot === 'limits-active') {
    await seedStubSetting(page, `capacity_dry_run:${AREA_ID}`, false);
  }
  // Same device count in both limits shots so the simulating→active pair reads
  // as one area before/after turning control on, not a phantom count change.
  await seedStubSetting(page, `pels_status:${AREA_ID}`, {
    controlledKw: 2.5, uncontrolledKw: 1.5, powerKnown: true, hasLivePowerSample: true,
    devicesOff: 1, limitReason: 'hourly',
  });
  await openLimitsPanel(page);
  await switchToArea(page);
  if (shot === 'limits-simulation') {
    await expect(page.locator('#home-limits-sim-notice')).toBeVisible();
  }
  if (shot === 'limits-active') {
    await expect(page.locator('#home-limits-status-chip')).toHaveText('Active');
  }
};

for (const shot of ['list', 'editor', 'limits-simulation', 'limits-active'] as Shot[]) {
  test(`capture ${shot}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: WIDTH, height: HEIGHT },
      // Touch (coarse pointer, no hover) flips PELS to the dark theme.
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await injectHomeyHostCss(page);
      await prepareShot(page, shot);
      await page.waitForTimeout(300);
      // Screenshot the panel element itself: a tight crop of just the Meter
      // Areas surface (no dead space on short panels, nothing cut off on tall
      // ones, and the off-topic whole-home dry-run banner is naturally excluded
      // since it lives outside the panel).
      const panel = shot === 'list' || shot === 'editor' ? '#homes-panel' : '#limits-panel';
      await page.locator(panel).screenshot({ path: `${OUT}/${shot}.png` });
    } finally {
      await context.close();
    }
  });
}
