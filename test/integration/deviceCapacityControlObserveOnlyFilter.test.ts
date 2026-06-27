// FIX 2: the capacity-control flow cards must NOT let a user pick an OBSERVE-ONLY device
// (battery / solar, structurally stamped `controllable: false`) into `controllable_devices`.
// No actuation escapes (the backend overrides such a device to non-controllable), but the
// persisted settings row would be an inconsistent no-op. The autocomplete must exclude
// observe-only devices, and a write hand-driven with a stale device arg must no-op.
//
// Drives the REAL `registerDeviceCapacityControlCards` against the shared mock flow seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance } from '../mocks/homey';
import { registerDeviceCapacityControlCards } from '../../flowCards/deviceSettingsCards';
import { CONTROLLABLE_DEVICES } from '../../lib/utils/settingsKeys';
import type { FlowCardDeps } from '../../flowCards/registerFlowCards';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';

const HEATER_ID = 'heater';
const BATTERY_ID = 'home-battery';
const SOLAR_ID = 'solar';

const snapshot = [
  { id: HEATER_ID, name: 'Heater', targets: [], deviceClass: 'heater', controllable: true },
  { id: BATTERY_ID, name: 'Home Battery', targets: [], deviceClass: 'battery', controllable: false },
  { id: SOLAR_ID, name: 'Solar Panel', targets: [], deviceClass: 'solarpanel', controllable: false },
] as unknown as DecoratedDeviceSnapshot[];

const infoSpy = vi.fn();

const buildDeps = (): FlowCardDeps => ({
  homey: mockHomeyInstance as unknown as FlowCardDeps['homey'],
  getSnapshot: async () => snapshot,
  getStructuredLogger: () => ({ info: infoSpy } as unknown as ReturnType<FlowCardDeps['getStructuredLogger']>),
} as unknown as FlowCardDeps);

describe('capacity-control cards exclude observe-only devices (FIX 2)', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    infoSpy.mockClear();
    registerDeviceCapacityControlCards(buildDeps());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('autocomplete offers the controllable heater but NOT the observe-only battery/solar', async () => {
    const listener = mockHomeyInstance.flow._actionCardAutocompleteListeners.enable_device_capacity_control.device;
    const options = await listener('') as Array<{ id: string }>;
    const ids = options.map((o) => o.id);
    expect(ids).toContain(HEATER_ID);
    expect(ids).not.toContain(BATTERY_ID);
    expect(ids).not.toContain(SOLAR_ID);
  });

  it('a write hand-driven with the solar device id is a no-op (no controllable_devices row written)', async () => {
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');
    const runListener = mockHomeyInstance.flow._actionCardListeners.enable_device_capacity_control;
    await runListener({ device: { id: SOLAR_ID } });

    // No controllable_devices write happened, and a skip was logged.
    expect(setSpy).not.toHaveBeenCalledWith(CONTROLLABLE_DEVICES, expect.anything());
    expect(mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES)).toBeUndefined();
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
