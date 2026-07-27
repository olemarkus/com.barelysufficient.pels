import { expect, test, type Page } from './fixtures/test';
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

/* -------------------------------------------------------------------------- *
 * "Multiple meters" management flows against the stubbed ui_homes endpoint:
 * progressive disclosure, the create flow (meter pick → ancestor-walk zone
 * prefill → zone-named default name → save round-trip), blocking overlap
 * validation, the non-blocking outside-zone warning, and the delete confirm.
 * -------------------------------------------------------------------------- */

const openWithRentalMeter = async (page: Page): Promise<void> => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await openHomesPanel(page);
};

test('empty state shows only the explainer and the Add affordance', async ({ page }) => {
  await gotoApp(page);
  await openHomesPanel(page);
  await expect(page.locator('#homes-empty-explainer')).toBeVisible();
  await expect(page.locator('#homes-empty-explainer')).toContainText('instead of the Main home');
  await expect(page.locator('#homes-list')).toHaveCount(0);
  await expect(page.locator('#homes-flow-source-notice')).toHaveCount(0);
  await expect(page.locator('#homes-add-button')).toBeVisible();
});

test('flow power source warns that meter areas need Homey Energy', async ({ page }) => {
  await gotoApp(page);
  // The runtime treats a non-Homey-Energy source (including unset) as Flow.
  await seedStubSetting(page, 'power_source', 'flow');
  await openHomesPanel(page);
  await expect(page.locator('#homes-flow-source-notice')).toBeVisible();
  await expect(page.locator('#homes-flow-source-notice')).toContainText('Homey Energy power source');
});

test('flow power source warning survives an unrelated whole-home meter read failure', async ({ page }) => {
  await gotoApp(page);
  await seedStubSetting(page, 'power_source', 'flow');
  await page.evaluate(() => {
    const homey = (window as unknown as {
      Homey: {
        get: (key: string, callback: (error: Error | null, value?: unknown) => void) => void;
      };
    }).Homey;
    const originalGet = homey.get.bind(homey);
    homey.get = (key, callback) => {
      if (key === 'homey_energy_meter_device_id') {
        setTimeout(() => callback(new Error('meter setting unavailable')), 0);
        return;
      }
      originalGet(key, callback);
    };
  });
  await openHomesPanel(page);
  await expect(page.locator('#homes-flow-source-notice')).toBeVisible();
});

test('create flow prefills zone by the ancestor walk, names it after the zone, and persists', async ({ page }) => {
  await openWithRentalMeter(page);
  await page.locator('#homes-add-button').click();
  await expect(page.locator('#homes-editor')).toBeVisible();
  // Meter in the leaf utility room under the rental part: the suggestion walks
  // up to the rental subtree root (the highest ancestor below the whole-home
  // root that contains no other area's meter).
  await page.selectOption('#homes-meter-select', 'dev_rental_meter');
  await expect(page.locator('#homes-zone-select')).toHaveValue('z_rental');
  await expect(page.locator('#homes-name-input')).toHaveValue('Rental unit');
  await page.locator('#homes-editor-save').click();
  // Saved via the settings key and refetched from ui_homes: the list renders
  // the runtime-normalized entry with meter name, zone name, and device count
  // (the rental meter itself is the one snapshot device inside the subtree).
  const row = page.locator('.homes-settings__row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Rental unit');
  await expect(row).toContainText('Rental meter · Rental unit · 1 device');
  await expect(page.locator('#homes-empty-explainer')).toHaveCount(0);
});

test('the beta notice leads the page in both the empty and the list states', async ({ page }) => {
  await gotoApp(page);
  await openHomesPanel(page);
  const notice = page.locator('#homes-beta-notice');
  await expect(notice).toBeVisible();
  // Locked copy (decision 11): confident, names the coverage gap, invites
  // reports — asserted in full so a hedged rewrite cannot slip in quietly.
  await expect(notice).toHaveText(
    'Meter areas are new. They work as intended, but some PELS features don’t cover them yet. '
    + 'Report anything unexpected and it gets fixed fast.',
  );

  // Same page with a configured area: the notice still leads the list.
  await gotoApp(page);
  await seedRentalArea(page);
  await openHomesPanel(page);
  await expect(page.locator('#homes-list')).toBeVisible();
  await expect(notice).toBeVisible();
});

test('overlap with an existing area blocks save; outside-zone meter only warns', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedUtilityMeterSnapshot(page);
  await seedRentalArea(page);
  await openHomesPanel(page);
  await page.locator('#homes-add-button').click();
  await page.selectOption('#homes-meter-select', 'dev_utility_meter');
  await expect(page.locator('#homes-zone-select')).toHaveValue('z_utility');
  // Overlap (live error): the rental area's own root zone.
  await page.selectOption('#homes-zone-select', 'z_rental');
  await expect(page.locator('#homes-editor')).toContainText('This zone overlaps “Rental unit”');
  await page.locator('#homes-editor-save').click();
  await expect(page.locator('#homes-editor')).toBeVisible();
  // Outside-zone (warning, non-blocking): a disjoint zone the meter is not in.
  await page.selectOption('#homes-zone-select', 'z_living');
  await expect(page.locator('#homes-editor')).toContainText('You can still save');
  await page.locator('#homes-editor-save').click();
  await expect(page.locator('.homes-settings__row')).toHaveCount(2);
});

test('saving an area without a whole-home meter is refused with the remedy', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  // The Main home back on Automatic: PELS would read every meter as its own.
  await seedStubSetting(page, 'homey_energy_meter_device_id', null);
  await openHomesPanel(page);
  await page.locator('#homes-add-button').click();
  await page.selectOption('#homes-meter-select', 'dev_rental_meter');
  await page.locator('#homes-editor-save').click();
  // Reason first, then the control named as a setting to change.
  await expect(page.locator('#toast')).toContainText('get limited by this area’s usage');
  await expect(page.locator('#toast')).toContainText('Set “Whole-home meter” under Limits & safety');
  await expect(page.locator('.homes-settings__row')).toHaveCount(0);
});

test('zone preview counts the devices in the chosen subtree, live', async ({ page }) => {
  await openWithRentalMeter(page);
  await page.locator('#homes-add-button').click();
  // Meter pick prefills z_rental; its subtree holds only the rental meter.
  await page.selectOption('#homes-meter-select', 'dev_rental_meter');
  const preview = page.locator('#homes-zone-device-count');
  await expect(preview).toHaveText('1 device in this zone and its sub-zones');
  // Garage holds the pool pump + the EV charger in the fixture.
  await page.selectOption('#homes-zone-select', 'z_garage');
  await expect(preview).toHaveText('2 devices in this zone and its sub-zones');
  // The whole-home root sweeps every zoned snapshot device (7 + the meter).
  await page.selectOption('#homes-zone-select', 'z_home');
  await expect(preview).toHaveText('8 devices in this zone and its sub-zones');
});

test('main-meter notice shows exactly for areas + Homey Energy + no explicit whole-home meter', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await seedStubSetting(page, 'power_source', 'homey_energy');
  await seedStubSetting(page, 'homey_energy_meter_device_id', null);
  await openHomesPanel(page);
  const notice = page.locator('#homes-main-meter-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Whole-home meter');
  await expect(notice.locator('md-text-button')).toHaveAttribute('data-settings-target', 'limits');
  // Configuring the whole-home meter retires the notice on the next panel open.
  await seedStubSetting(page, 'homey_energy_meter_device_id', 'dev_main_meter');
  await page.locator('#homes-panel [data-settings-target="settings"]').click();
  await openHomesPanel(page);
  await expect(page.locator('.homes-settings__row')).toHaveCount(1);
  await expect(notice).toHaveCount(0);
  // The flow power source never prompts (PELS reads no meters there).
  await seedStubSetting(page, 'homey_energy_meter_device_id', null);
  await seedStubSetting(page, 'power_source', 'flow');
  await page.locator('#homes-panel [data-settings-target="settings"]').click();
  await openHomesPanel(page);
  await expect(page.locator('.homes-settings__row')).toHaveCount(1);
  await expect(notice).toHaveCount(0);
});

test('degraded config disables every mutation control and explains why', async ({ page }) => {
  await installDegradedHomesPayload(page);
  await gotoApp(page);
  await openHomesPanel(page);
  await expect(page.locator('.homes-settings__row')).toHaveCount(1);
  await expect(page.locator('#homes-panel')).toContainText('can’t safely change meter areas');
  const addDisabled = await page.locator('#homes-add-button')
    .evaluate((element) => (element as HTMLElement & { disabled?: boolean }).disabled === true);
  expect(addDisabled).toBe(true);
  const rowButtonsDisabled = await page.locator('.homes-settings__actions md-text-button')
    .evaluateAll((elements) => elements
      .every((element) => (element as HTMLElement & { disabled?: boolean }).disabled === true));
  expect(rowButtonsDisabled).toBe(true);
});

test('an area removed elsewhere reconciles into the open editor as Add again', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await openHomesPanel(page);
  await page.locator('.homes-settings__row md-text-button', { hasText: 'Edit' }).click();
  await expect(page.locator('#homes-editor')).toBeVisible();
  // Another session removes the area while the editor is open…
  await seedStubSetting(page, 'homes_config', { subHomes: [] });
  // …and the next panel activation's refetch reconciles the open editor.
  await page.locator('#homes-panel [data-settings-target="settings"]').click();
  await openHomesPanel(page);
  await expect(page.locator('#homes-editor-area-gone')).toBeVisible();
  await expect(page.locator('#homes-editor-save')).toHaveText('Add again');
  // Saving honestly re-adds the area (upsert with the vanished id).
  await page.locator('#homes-editor-save').click();
  await expect(page.locator('.homes-settings__row')).toHaveCount(1);
  await expect(page.locator('.homes-settings__row')).toContainText('Rental unit');
});

test('delete needs a confirm step that names the re-homing consequence', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await openHomesPanel(page);
  const row = page.locator('.homes-settings__row');
  await expect(row).toHaveCount(1);
  await row.locator('md-text-button', { hasText: 'Remove' }).click();
  await expect(row).toContainText('Remove “Rental unit”? Its devices move back to the Main home.');
  await row.locator('.homes-settings__confirm md-text-button', { hasText: 'Remove' }).click();
  await expect(page.locator('#homes-empty-explainer')).toBeVisible();
});
