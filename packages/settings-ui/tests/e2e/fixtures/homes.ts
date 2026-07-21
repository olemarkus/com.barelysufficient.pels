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

/** Install the power-device list override (default five + the rental meter). */
export const installRentalMeterDeviceList = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const stubWindow = window as StubWindow;
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...(stubWindow.__PELS_HOMEY_STUB__ ?? {}),
      apiHandlers: {
        ...(stubWindow.__PELS_HOMEY_STUB__?.apiHandlers ?? {}),
        // Mirrors the stub's default homey_devices list + the rental meter.
        'GET /homey_devices': () => [
          { id: 'dev_outdoor', name: 'Outdoor sensor', hasTemperature: true, hasPower: false },
          { id: 'dev_heatpump', name: 'Living Room Heat Pump', hasTemperature: true, hasPower: true },
          { id: 'dev_floorheat', name: 'Bathroom Floor Heat', hasTemperature: true, hasPower: true },
          { id: 'dev_waterheater', name: 'Water Heater', hasTemperature: false, hasPower: true },
          { id: 'dev_evcharger', name: 'Generic EV Charger', hasTemperature: false, hasPower: true },
          { id: 'dev_rental_meter', name: 'Rental meter', hasTemperature: false, hasPower: true },
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

/** Seed one configured meter area (the rental unit) into the stub settings. */
export const seedRentalArea = async (page: Page): Promise<void> => {
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
  // Enable the hidden multi-home feature flag (default off) BEFORE boot, so the
  // bootstrap un-hides the "Multiple meters" nav card and the ui_homes payload
  // reports multiHomeEnabled. Merges into any earlier __PELS_HOMEY_STUB__
  // override (device list / degraded payload) so their apiHandlers survive.
  await page.addInitScript(() => {
    const stubWindow = window as StubWindow;
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...(stubWindow.__PELS_HOMEY_STUB__ ?? {}),
      settings: {
        ...(stubWindow.__PELS_HOMEY_STUB__?.settings ?? {}),
        multi_home_enabled: true,
      },
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
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
          multiHomeEnabled: true,
          homes: [{
            homeId: 'h_11111111', name: 'Rental unit', rootZoneId: 'z_rental', meterDeviceId: 'dev_rental_meter',
          }],
          membershipByDeviceId: {},
          zoneTree: {
            z_home: { id: 'z_home', name: 'Home', parent: null },
            z_rental: { id: 'z_rental', name: 'Rental unit', parent: 'z_home' },
          },
          hasSubHomes: true,
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
