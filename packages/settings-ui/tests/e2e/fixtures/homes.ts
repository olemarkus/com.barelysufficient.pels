import type { Page } from '@playwright/test';
import { expect } from './test';

// Shared seeding for the "Multiple meters" specs: a rental-unit meter device
// that reports power but is not a managed candidate by default. The
// homey_devices override must be installed BEFORE navigation (the stub reads
// `window.__PELS_HOMEY_STUB__` at load); the snapshot append runs after load
// so it builds on the stub's default fixture.

type StubWindow = Window & {
  __PELS_HOMEY_STUB__?: {
    apiHandlers?: Record<string, () => unknown>;
    settings?: Record<string, unknown>;
  };
  Homey?: {
    __stub: {
      getSetting: (key: string) => unknown;
      setSetting: (key: string, value: unknown) => void;
    };
  };
};

/** Install the meter-list override (the two sensor meters the specs assign to areas). */
export const installRentalMeterDeviceList = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const stubWindow = window as StubWindow;
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...(stubWindow.__PELS_HOMEY_STUB__ ?? {}),
      apiHandlers: {
        ...(stubWindow.__PELS_HOMEY_STUB__?.apiHandlers ?? {}),
        // Both meter pickers read the endpoint's resolved meter list (whole-home
        // cumulative + sensor-class device meters), already narrowed to real
        // meters — appliances never appear here. The fixture home has two
        // sensor sub-meters the specs assign to areas.
        'GET /homey_energy_meters': () => [
          { id: 'dev_rental_meter', name: 'Rental meter' },
          { id: 'dev_utility_meter', name: 'Utility meter' },
        ],
      },
    };
  });
};

/** Append the rental meter to the snapshot so `ui_devices` serves its zone. */
export const seedRentalMeterSnapshot = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const stub = (window as StubWindow).Homey?.__stub;
    if (!stub) throw new Error('Homey stub missing');
    const snapshot = stub.getSetting('target_devices_snapshot') as Array<Record<string, unknown>>;
    if (snapshot.some((device) => device.id === 'dev_rental_meter')) return;
    stub.setSetting('target_devices_snapshot', [...snapshot, {
      id: 'dev_rental_meter',
      name: 'Rental meter',
      deviceClass: 'sensor',
      zone: 'Rental utility',
      zoneId: 'z_rental_utility',
      measuredPowerKw: 0.3,
    }]);
  });
};

/**
 * Append a sensor sub-meter in the utility room (a zone OUTSIDE the rental
 * subtree) to the snapshot, so a spec can pick a real meter whose zone prefills
 * z_utility and then exercise the overlap/outside-zone warnings.
 */
export const seedUtilityMeterSnapshot = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const stub = (window as StubWindow).Homey?.__stub;
    if (!stub) throw new Error('Homey stub missing');
    const snapshot = stub.getSetting('target_devices_snapshot') as Array<Record<string, unknown>>;
    if (snapshot.some((device) => device.id === 'dev_utility_meter')) return;
    stub.setSetting('target_devices_snapshot', [...snapshot, {
      id: 'dev_utility_meter',
      name: 'Utility meter',
      deviceClass: 'sensor',
      zone: 'Utility room',
      zoneId: 'z_utility',
      measuredPowerKw: 0.2,
    }]);
  });
};

/** Seed one configured meter area (the rental unit) into the stub settings. */
export const seedRentalArea = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const stub = (window as StubWindow).Homey?.__stub;
    if (!stub) throw new Error('Homey stub missing');
    stub.setSetting('homes_config', {
      activationVersion: 1,
      subHomes: [{
        homeId: 'h_11111111',
        name: 'Rental unit',
        rootZoneId: 'z_rental',
        meterDeviceId: 'dev_rental_meter',
      }],
    });
  });
};

/** Seed the same area in the pre-GA held posture: populated, but not activated. */
export const seedHeldRentalArea = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const stub = (window as StubWindow).Homey?.__stub;
    if (!stub) throw new Error('Homey stub missing');
    stub.setSetting('homes_config', {
      subHomes: [{
        homeId: 'h_11111111',
        name: 'Rental unit',
        rootZoneId: 'z_rental',
        meterDeviceId: 'dev_rental_meter',
      }],
    });
  });
};

export const gotoApp = async (page: Page): Promise<void> => {
  // Multiple meters is always on: the bootstrap un-hides the nav card and serves
  // the ui_homes payload unconditionally — no pre-boot seeding required. Any
  // earlier __PELS_HOMEY_STUB__ override (device list / degraded payload)
  // installed by a sibling fixture stays intact.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  // Meter areas require the Homey Energy power source; the runtime never writes a
  // default, so these fixtures model the Homey Energy owner explicitly. A spec
  // that exercises the Flow warning overrides this afterwards.
  await seedStubSetting(page, 'power_source', 'homey_energy');
};

/** Seed an arbitrary stub setting (e.g. power_source) before panel activation. */
export const seedStubSetting = async (page: Page, key: string, value: unknown): Promise<void> => {
  await page.evaluate(([settingKey, settingValue]) => {
    const stub = (window as StubWindow).Homey?.__stub;
    if (!stub) throw new Error('Homey stub missing');
    stub.setSetting(settingKey as string, settingValue);
  }, [key, value]);
};

/** Install a degraded ui_homes override: one area served, configDegraded true. */
export const installDegradedHomesPayload = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const stubWindow = window as StubWindow;
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...(stubWindow.__PELS_HOMEY_STUB__ ?? {}),
      apiHandlers: {
        ...(stubWindow.__PELS_HOMEY_STUB__?.apiHandlers ?? {}),
        'GET /ui_homes': () => ({
          homes: [{
            homeId: 'h_11111111', name: 'Rental unit', rootZoneId: 'z_rental', meterDeviceId: 'dev_rental_meter',
          }],
          membershipByDeviceId: {},
          zoneTree: {
            z_home: { id: 'z_home', name: 'Home', parent: null },
            z_rental: { id: 'z_rental', name: 'Rental unit', parent: 'z_home' },
          },
          hasSubHomes: true,
          runtimeActive: true,
          configDegraded: true,
        }),
      },
    };
  });
};

export const openHomesPanel = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const navCard = page.locator('.settings-nav-card[data-settings-target="homes"]');
  await navCard.scrollIntoViewIfNeeded();
  await navCard.click();
  await expect(page.locator('#homes-panel')).toBeVisible();
};
