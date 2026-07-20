import { expect, test, type Page } from './fixtures/test';
import {
  gotoApp,
  installRentalMeterDeviceList,
  seedRentalArea,
  seedRentalMeterSnapshot,
} from './fixtures/homes';

/* -------------------------------------------------------------------------- *
 * Per-home Limits & safety flow (multi-home U3): the switcher appears once a
 * meter area exists, picking the area shows its editor + the activation notice
 * (areas default to simulation), turning ON the positive "Control devices in
 * this area" toggle persists `capacity_dry_run:<homeId>` = false (THE activation
 * step), and a cap edit persists `capacity_limit_kw:<homeId>`. The Main home
 * keeps its static form and its bare keys.
 * -------------------------------------------------------------------------- */

const AREA_ID = 'h_11111111';

const openLimitsPanel = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const navCard = page.locator('.settings-nav-card[data-settings-target="limits"]');
  await navCard.scrollIntoViewIfNeeded();
  await navCard.click();
  await expect(page.locator('#limits-panel')).toBeVisible();
};

const readStubSetting = (page: Page, key: string): Promise<unknown> => page.evaluate(
  (settingKey) => (window as unknown as {
    Homey: { __stub: { getSetting: (k: string) => unknown } };
  }).Homey.__stub.getSetting(settingKey),
  key,
);

test('single-home user sees the unchanged static form, no switcher', async ({ page }) => {
  await gotoApp(page);
  await openLimitsPanel(page);
  await expect(page.locator('#home-limits-home-select')).toHaveCount(0);
  await expect(page.locator('#settings-limits-form')).toBeVisible();
  await expect(page.locator('#settings-capacity-limit')).toBeVisible();
});

test('a meter area activates control: switch, turn control on, set a cap', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await openLimitsPanel(page);

  // The switcher now offers Main home + the meter area; Main keeps the static form.
  const switcher = page.locator('#home-limits-home-select');
  await expect(switcher).toBeVisible();
  await expect(page.locator('#settings-limits-form')).toBeVisible();

  // Pick the meter area: the static form hides, the per-home editor appears, and
  // — because a fresh area defaults to simulation — the activation notice shows.
  await switcher.selectOption(AREA_ID);
  await expect(page.locator('#home-limits-hard-cap')).toBeVisible();
  await expect(page.locator('#settings-limits-form')).toBeHidden();
  await expect(page.locator('#home-limits-sim-notice')).toBeVisible();
  await expect(page.locator('#home-limits-sim-notice')).toContainText('turn on control');

  // Turn control ON — the activation step. The suffixed key persists false
  // (dry-run off) and the notice clears.
  await page.locator('#home-limits-simulation-switch').click();
  await expect(page.locator('#home-limits-sim-notice')).toHaveCount(0);
  await expect.poll(() => readStubSetting(page, `capacity_dry_run:${AREA_ID}`)).toBe(false);

  // Set a hard cap for the area — persists the suffixed key, never the bare one.
  await page.locator('#home-limits-hard-cap').fill('9');
  await page.locator('#home-limits-hard-cap').blur();
  await expect.poll(() => readStubSetting(page, `capacity_limit_kw:${AREA_ID}`)).toBe(9);
  await expect(readStubSetting(page, 'capacity_dry_run')).resolves.not.toBe(false);
});
