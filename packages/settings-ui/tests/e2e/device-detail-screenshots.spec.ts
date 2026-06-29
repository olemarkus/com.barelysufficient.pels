/**
 * Captures device detail panel screenshots for visual / UX review.
 * Skipped in CI — run locally with:
 *   npx playwright test device-detail-screenshots.spec.ts --project=chromium-mobile-width
 */
import { expect, renderTest as test, type Page } from './fixtures/test';
import { setMdSwitch, setMdValue } from './fixtures/materialWeb';

const OUT = '../../docs/public/screenshots/device-detail';

test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(Boolean(process.env.CI), 'Device-detail screenshots are for local use only');
  test.skip(
    testInfo.project.name !== 'chromium-mobile-width',
    'Screenshots are pinned to chromium-mobile-width to avoid clobbering.',
  );
});

test.use({ viewport: { width: 480, height: 900 } });

const prepPage = async (page: Page) => {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
  });
  await page.waitForTimeout(200);
};

const openDeviceDetail = async (page: Page, deviceId: string) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  const row = page.locator(`#devices-panel [data-device-id="${deviceId}"]`).first();
  await expect(row).toBeVisible();
  await row.locator('.pels-device-card__detail-button').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
  await prepPage(page);
};

const captureFullPanel = async (page: Page, name: string) => {
  const panel = page.locator('#device-detail-panel');
  await panel.screenshot({ path: `${OUT}/${name}.png` });
};

test('header and modes (thermostat)', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  await page.waitForTimeout(300);
  await captureFullPanel(page, 'thermostat-top');
});

test('shedding section with conditional row', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  await page.locator('#device-detail-shedding-section').scrollIntoViewIfNeeded();
  const segmented = page.locator('#device-detail-overshoot-segmented');
  await segmented.locator('.segmented__option', { hasText: 'Set to temperature' }).click();
  await page.waitForTimeout(200);
  await page.locator('#device-detail-shedding-section').screenshot({
    path: `${OUT}/shedding-with-temperature.png`,
  });
});

test('stepped load (zaptec)', async ({ page }) => {
  await openDeviceDetail(page, 'dev_zaptec');
  await page.locator('#device-detail-stepped-section').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.locator('#device-detail-stepped-section').screenshot({
    path: `${OUT}/stepped-zaptec.png`,
  });
});

test('setup section', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  const setup = page.locator('#device-detail-setup-section');
  await setup.locator('summary').click();
  await setup.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await setup.screenshot({ path: `${OUT}/setup-expanded.png` });
});

test('diagnostics disclosure open', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  const diag = page.locator('#device-detail-diagnostics-disclosure');
  await diag.locator('summary').click();
  await diag.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.locator('#device-detail-diagnostics-section').screenshot({
    path: `${OUT}/diagnostics-open.png`,
  });
});

test('solar surplus control and boost', async ({ page }) => {
  // The fixture home has a tracked solar/PV device, so the "Use solar surplus"
  // control is offered on this managed thermostat. Used by docs/solar.md.
  await openDeviceDetail(page, 'dev_heatpump');
  // The toggle lives in the Setup cluster; expand it, then turn it on so the
  // field-only "Solar surplus" boost card is revealed.
  await page.locator('#device-detail-setup-section summary').click();
  await page.waitForTimeout(150);
  await setMdSwitch(page, '#device-detail-surplus-opt', true);
  await setMdValue(page, '#device-detail-surplus-delta', '2');
  await page.waitForTimeout(250);

  const toggleRow = page.locator('#device-detail-surplus-opt-row');
  await toggleRow.scrollIntoViewIfNeeded();
  await expect(toggleRow).toBeVisible();
  await page.waitForTimeout(150);
  await toggleRow.screenshot({ path: `${OUT}/solar-surplus-toggle.png` });

  const boost = page.locator('#device-detail-surplus-section');
  await boost.scrollIntoViewIfNeeded();
  await expect(boost).toBeVisible();
  await page.waitForTimeout(150);
  await boost.screenshot({ path: `${OUT}/solar-surplus-boost.png` });
});
