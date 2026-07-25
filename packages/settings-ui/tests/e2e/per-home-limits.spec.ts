import { expect, test, type Page } from './fixtures/test';
import {
  gotoApp,
  installRentalMeterDeviceList,
  seedHeldRentalArea,
  seedRentalArea,
  seedRentalMeterSnapshot,
  seedStubSetting,
} from './fixtures/homes';

/* -------------------------------------------------------------------------- *
 * Per-home Limits & safety flow (multi-home U3): the switcher appears once a
 * meter area exists, picking the area shows its editor + the activation notice
 * (areas default to simulation), turning ON the positive "Control devices in
 * this area" toggle starts device control by persisting
 * `capacity_dry_run:<homeId>` = false, and a cap edit persists
 * `capacity_limit_kw:<homeId>`. The Main home keeps its static form and bare
 * keys.
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

test('Main simulation banner stays truthful while a meter area actively controls devices', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addInitScript(() => {
    const stubWindow = window as Window & {
      __PELS_HOMEY_STUB__?: { settings?: Record<string, unknown> };
    };
    const existing = stubWindow.__PELS_HOMEY_STUB__ ?? {};
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...existing,
      settings: {
        ...(existing.settings ?? {}),
        capacity_dry_run: true,
        'capacity_dry_run:h_11111111': false,
        homes_config: {
          activationVersion: 1,
          subHomes: [{
            homeId: 'h_11111111',
            name: 'Rental unit',
            rootZoneId: 'z_rental',
            meterDeviceId: 'dev_rental_meter',
          }],
        },
        'pels_status:h_11111111': {
          controlledKw: 2.5,
          uncontrolledKw: 1.5,
          powerKnown: true,
          hasLivePowerSample: true,
          devicesOff: 1,
          limitReason: 'hourly',
        },
      },
    };
  });
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await openLimitsPanel(page);
  await page.locator('#home-limits-home-select').selectOption(AREA_ID);

  await expect(page.locator('#home-limits-status-chip')).toHaveText('Active');
  await expect(page.locator('#home-limits-status-line')).toContainText('Limiting 1 device');
  await expect(page.locator('#dry-run-banner')).toContainText(
    'Main home simulation on — Main home devices stay as-is',
  );
  await expect(page.locator('#simulation-disable-button')).toHaveText('Turn off Main simulation');
  const bannerLayout = await page.evaluate(() => {
    const banner = document.querySelector('#dry-run-banner')!.getBoundingClientRect();
    const text = document.querySelector('#dry-run-banner-text')!.getBoundingClientRect();
    const action = document.querySelector('#simulation-disable-button')!.getBoundingClientRect();
    return {
      height: Math.round(banner.height),
      textWidth: Math.round(text.width),
      textBottom: Math.round(text.bottom),
      actionTop: Math.round(action.top),
    };
  });
  expect(bannerLayout.textWidth).toBeGreaterThanOrEqual(180);
  expect(bannerLayout.actionTop).toBeGreaterThanOrEqual(bannerLayout.textBottom - 1);
  expect(bannerLayout.height).toBeLessThanOrEqual(150);
});

test('simulation banner keeps a conservative scope across transient and realtime roster changes', async ({ page }) => {
  await gotoApp(page);
  const banner = page.locator('#dry-run-banner');
  const action = page.locator('#simulation-disable-button');
  await expect(banner).toContainText('Simulation on — devices stay as-is');

  await page.evaluate(() => {
    const stub = (window as unknown as {
      Homey: {
        __stub: {
          emitSettingsSet: (key: string) => void;
          setSetting: (key: string, value: unknown) => void;
        };
      };
    }).Homey.__stub;
    stub.setSetting('homes_config_initialized', true);
    stub.setSetting('homes_config', undefined);
    stub.emitSettingsSet('homes_config_initialized');
  });
  await expect(banner).toContainText('Main home simulation on — Main home devices stay as-is');
  await expect(action).toHaveText('Turn off Main simulation');

  await page.evaluate(() => {
    const stub = (window as unknown as {
      Homey: {
        __stub: {
          emitSettingsSet: (key: string) => void;
          setSetting: (key: string, value: unknown) => void;
        };
      };
    }).Homey.__stub;
    stub.setSetting('homes_config', {
      activationVersion: 1,
      subHomes: [{
        homeId: 'h_11111111',
        name: 'Rental unit',
        rootZoneId: 'z_rental',
        meterDeviceId: 'dev_rental_meter',
      }],
    });
    stub.emitSettingsSet('homes_config');
  });
  await expect(banner).toContainText('Main home simulation on — Main home devices stay as-is');

  await page.evaluate(() => {
    const stub = (window as unknown as {
      Homey: {
        __stub: {
          emitSettingsSet: (key: string) => void;
          setSetting: (key: string, value: unknown) => void;
        };
      };
    }).Homey.__stub;
    stub.setSetting('homes_config', { activationVersion: 1, subHomes: [] });
    stub.emitSettingsSet('homes_config');
  });
  await expect(banner).toContainText('Simulation on — devices stay as-is');
  await expect(action).toHaveText('Turn off simulation');
});

test('a held pre-GA meter area cannot claim active control or stale live power', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedHeldRentalArea(page);
  await seedStubSetting(page, `capacity_dry_run:${AREA_ID}`, false);
  await seedStubSetting(page, `pels_status:${AREA_ID}`, {
    controlledKw: 2.5,
    uncontrolledKw: 1.5,
    powerKnown: true,
    hasLivePowerSample: true,
    devicesOff: 0,
    limitReason: 'none',
  });
  await openLimitsPanel(page);
  await page.locator('#home-limits-home-select').selectOption(AREA_ID);

  const control = page.locator('#home-limits-simulation-switch');
  // Material's custom element owns disabled semantics inside its shadow root;
  // pin the reflected property/attribute instead of native-form detection.
  await expect(control).toHaveAttribute('disabled', '');
  await expect(control).toHaveJSProperty('selected', false);
  await expect(page.locator('#home-limits-status-chip')).toHaveText('Not active');
  await expect(page.locator('#home-limits-status-power')).toHaveText('—');
  await expect(page.locator('#home-limits-inactive-notice'))
    .toContainText('open Multiple meters and save this area');
});
