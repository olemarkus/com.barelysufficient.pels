// FIX 2: the capacity-control flow cards must NOT let a user pick a solar device into
// `controllable_devices`: the persisted settings row would be an inconsistent no-op. The
// autocomplete must exclude it, and a write hand-driven with a stale device arg must no-op.
// A home battery is the exception: its Power-limit control IS the `controllable_devices`
// entry (read through `isBatteryPowerLimitEnabled`), so both cards accept it.
//
// Drives the REAL `registerDeviceCapacityControlCards` against the shared mock flow seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance } from '../mocks/homey';
import { registerCapacityControlCondition, registerDeviceCapacityControlCards } from '../../flowCards/deviceSettingsCards';
import { CONTROLLABLE_DEVICES } from '../../lib/utils/settingsKeys';
import type { FlowCardDeps } from '../../flowCards/registerFlowCards';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';

const HEATER_ID = 'heater';
const BATTERY_ID = 'home-battery';
const SOLAR_ID = 'solar';

const snapshot = [
  { id: HEATER_ID, name: 'Heater', targets: [], deviceClass: 'heater', controllable: true },
  {
    id: BATTERY_ID, name: 'Home Battery', targets: [], deviceClass: 'battery', isBatteryOrSolar: true,
    controllable: false, managed: true,
  },
  { id: SOLAR_ID, name: 'Solar Panel', targets: [], deviceClass: 'solarpanel', isBatteryOrSolar: true, controllable: false },
] as unknown as DecoratedDeviceSnapshot[];

const infoSpy = vi.fn();

const buildDeps = (): FlowCardDeps => ({
  homey: mockHomeyInstance as unknown as FlowCardDeps['homey'],
  getSnapshot: async () => snapshot,
  getDeviceDescriptors: async () => snapshot,
  getStructuredLogger: () => ({ info: infoSpy } as unknown as ReturnType<FlowCardDeps['getStructuredLogger']>),
} as unknown as FlowCardDeps);

describe('capacity-control cards exclude solar devices and accept a home battery (FIX 2)', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    infoSpy.mockClear();
    registerDeviceCapacityControlCards(buildDeps());
    registerCapacityControlCondition(buildDeps());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['enable_device_capacity_control', 'disable_device_capacity_control'])(
    '%s offers the heater and the home battery, but NOT the solar device',
    async (cardId) => {
      const listener = mockHomeyInstance.flow._actionCardAutocompleteListeners[cardId].device;
      const options = await listener('') as Array<{ id: string }>;
      const ids = options.map((o) => o.id);
      expect(ids).toContain(HEATER_ID);
      expect(ids).toContain(BATTERY_ID);
      expect(ids).not.toContain(SOLAR_ID);
    },
  );

  it('the capacity-controlled condition offers the battery and reads its Power-limit control (absent = on)', async () => {
    const options = await mockHomeyInstance.flow._conditionCardAutocompleteListeners
      .is_device_capacity_controlled.device('') as Array<{ id: string }>;
    expect(options.map((o) => o.id)).toEqual(expect.arrayContaining([HEATER_ID, BATTERY_ID]));
    expect(options.map((o) => o.id)).not.toContain(SOLAR_ID);

    const isControlled = mockHomeyInstance.flow._conditionCardListeners.is_device_capacity_controlled;
    expect(await isControlled({ device: { id: BATTERY_ID } })).toBe(true);
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [BATTERY_ID]: false });
    expect(await isControlled({ device: { id: BATTERY_ID } })).toBe(false);
  });

  it('turns a home battery\'s Power-limit control on and off', async () => {
    await mockHomeyInstance.flow._actionCardListeners.enable_device_capacity_control({ device: { id: BATTERY_ID } });
    expect(mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES)).toEqual({ [BATTERY_ID]: true });
    await mockHomeyInstance.flow._actionCardListeners.disable_device_capacity_control({ device: { id: BATTERY_ID } });
    expect(mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES)).toEqual({ [BATTERY_ID]: false });
  });

  it('a write hand-driven with the solar device id is a no-op (no controllable_devices row written)', async () => {
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');
    const runListener = mockHomeyInstance.flow._actionCardListeners.enable_device_capacity_control;
    await runListener({ device: { id: SOLAR_ID } });

    // No controllable_devices write happened, and a skip was logged.
    expect(setSpy).not.toHaveBeenCalledWith(CONTROLLABLE_DEVICES, expect.anything());
    expect(mockHomeyInstance.settings.getKeys()).not.toContain(CONTROLLABLE_DEVICES);
    expect(infoSpy).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_setting_toggle_skipped',
      deviceId: SOLAR_ID,
    }));
  });

  it('a write for the controllable heater still persists the controllable_devices row', async () => {
    const runListener = mockHomeyInstance.flow._actionCardListeners.enable_device_capacity_control;
    await runListener({ device: { id: HEATER_ID } });
    expect(mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES)).toEqual({ [HEATER_ID]: true });
  });
});
