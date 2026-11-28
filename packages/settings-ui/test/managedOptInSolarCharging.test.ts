import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { state } from '../src/ui/state.ts';
import {
  applyManagedOptInSolarCharging,
  resolveManagedOptInSolarCharging,
} from '../src/ui/deviceDetail/managedOptInSolarCharging.ts';
import { PRICE_OPTIMIZATION_SETTINGS } from '../../shared-domain/src/settings/settingsKeys.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';

/* -------------------------------------------------------------------------- *
 * Turning Managed on for an EV charger in a home with solar turns on "Charge
 * on solar surplus" and "Charge from the grid when the panels stop" together,
 * with the same write the charger page makes. Any saved entry for the device
 * is left alone.
 * -------------------------------------------------------------------------- */

const charger = (overrides: Partial<SettingsUiDeviceSnapshot> = {}): SettingsUiDeviceSnapshot => ({
  id: 'charger-1',
  name: 'Charger',
  targets: [],
  deviceClass: 'evcharger',
  isEvCharger: true,
  powerCapable: true,
  controlModel: 'stepped_load',
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
      { id: '16a', planningPowerW: 3680, planningCurrentA: 16 },
    ],
  },
  capabilities: ['evcharger_charging'],
  ...overrides,
}) as SettingsUiDeviceSnapshot;

const savedEntry = {
  enabled: false,
  cheapDelta: 0,
  expensiveDelta: 0,
  priceConfigured: false,
  surplusWilling: false,
  surplusDelta: 0,
  gridWhenPanelsStop: false,
};

const setSolarHome = (hasSolarDevice: boolean, exports = hasSolarDevice): void => {
  state.devicesLoaded = true;
  state.hasManagedSolarDevice = hasSolarDevice;
  state.hasExhibitedExport = exports;
  state.surplusPoolReachable = exports;
};

describe('Managed on for an EV charger in a solar home', () => {
  let homey: MockHomeyClient;

  beforeEach(() => {
    homey = installHomeyMock({ settings: {} });
    setHomeyClient(homey as never);
    state.latestDevices = [charger()];
    state.managedMap = { 'charger-1': true };
    state.controllableMap = { 'charger-1': true };
    state.priceOptimizationSettings = {};
    state.priceOptimizationSettingsLoaded = true;
    state.deviceTargetPowerConfigs = {};
    setSolarHome(true);
  });

  afterEach(() => {
    setHomeyClient(null);
  });

  it('turns on solar surplus charging and grid charging once the panels stop', async () => {
    expect(resolveManagedOptInSolarCharging(charger())).toBe('enable');
    await applyManagedOptInSolarCharging('charger-1', () => undefined, () => true);
    expect(state.priceOptimizationSettings['charger-1']).toMatchObject({
      surplusWilling: true, gridWhenPanelsStop: true, enabled: false,
    });
    const stored = homey.__settingsStore[PRICE_OPTIMIZATION_SETTINGS] as Record<string, typeof savedEntry>;
    expect(stored['charger-1']).toMatchObject({ surplusWilling: true, gridWhenPanelsStop: true });
  });

  it('leaves a charger with a saved entry alone', async () => {
    state.priceOptimizationSettings = { 'charger-1': { ...savedEntry } };
    expect(resolveManagedOptInSolarCharging(charger())).toBe('leave');
    await applyManagedOptInSolarCharging('charger-1', () => undefined, () => true);
    expect(state.priceOptimizationSettings['charger-1']).toEqual(savedEntry);
    expect(homey.__settingsStore[PRICE_OPTIMIZATION_SETTINGS]).toBeUndefined();
  });

  it('leaves a home without solar alone', async () => {
    setSolarHome(false);
    expect(resolveManagedOptInSolarCharging(charger())).toBe('leave');
    await applyManagedOptInSolarCharging('charger-1', () => undefined, () => true);
    expect(state.priceOptimizationSettings).toEqual({});
  });

  it('leaves a home that shows solar only through its meter\'s export alone', async () => {
    // No solar device in Homey reports production, so PELS could never see
    // the panels stop and the car would wait every night.
    setSolarHome(false, true);
    expect(resolveManagedOptInSolarCharging(charger())).toBe('leave');
    await applyManagedOptInSolarCharging('charger-1', () => undefined, () => true);
    expect(state.priceOptimizationSettings).toEqual({});
  });

  it('leaves the saved map alone while it has not loaded', async () => {
    // An unread map reads as empty; writing into it would replace every entry.
    state.priceOptimizationSettingsLoaded = false;
    expect(resolveManagedOptInSolarCharging(charger())).toBe('leave');
    await applyManagedOptInSolarCharging('charger-1', () => undefined, () => true);
    expect(homey.__settingsStore[PRICE_OPTIMIZATION_SETTINGS]).toBeUndefined();
  });

  it('leaves a device that is not an EV charger alone', () => {
    const heater = charger({ id: 'heater-1', deviceClass: 'heater', isEvCharger: false, capabilities: [] });
    state.latestDevices = [heater];
    state.managedMap = { 'heater-1': true };
    expect(resolveManagedOptInSolarCharging(heater)).toBe('leave');
  });

  it('leaves a charger the solar switch is not offered for', () => {
    // No step ladder and no EV preset: "Charge on solar surplus" is not on its page.
    const onOff = charger({ controlModel: 'binary_power', steppedLoadProfile: undefined });
    state.latestDevices = [onOff];
    expect(resolveManagedOptInSolarCharging(onOff)).toBe('leave');
  });

  it('writes nothing once the owner has turned Managed off again', async () => {
    await applyManagedOptInSolarCharging('charger-1', () => undefined, () => false);
    expect(state.priceOptimizationSettings).toEqual({});
  });
});
