import { describe, expect, it } from 'vitest';
import { resolveFlowAugmentedDeviceType } from '../../lib/device/transport/flowReportedCapabilities';
import { resolveDeviceClassKey } from '../../lib/device/transport/managerHelpers';
import type { HomeyDeviceLike } from '../../lib/utils/types';

// A home battery is MANAGED OBSERVE-ONLY: it must never be classified as a `binary`
// flow-backed device, because that makes it eligible for flow-backed binary device
// cards whose action listener persists a reported `onoff` state — a control/actuation
// surface. `resolveFlowAugmentedDeviceType` is the single upstream chokepoint: both
// the parse binary classification AND flow-backed card registration / onoff-persistence
// (`flowBackedDeviceCards.ts` `isSupportedFlowBackedDevice`) gate on its result.
describe('resolveFlowAugmentedDeviceType — home battery exclusion', () => {
  it('returns "unsupported" for a battery class-key (never "binary")', () => {
    expect(resolveFlowAugmentedDeviceType({
      deviceClassKey: 'battery',
      targetCapabilityIds: [],
    })).toBe('unsupported');
  });

  it('returns "unsupported" for a role-detected battery via its normalized class-key', () => {
    // class:'battery' normalizes to the 'battery' class-key.
    const classBattery: HomeyDeviceLike = {
      id: 'b1', name: 'Battery', class: 'battery', capabilities: ['measure_battery', 'measure_power'],
    };
    // energy-role-only battery (real class not a supported class) also normalizes.
    const roleBattery: HomeyDeviceLike = {
      id: 'b2', name: 'Inverter', class: 'sensor', energy: { homeBattery: true },
      capabilities: ['measure_battery', 'measure_power'],
    };
    for (const device of [classBattery, roleBattery]) {
      const deviceClassKey = resolveDeviceClassKey(device);
      expect(deviceClassKey).toBe('battery');
      expect(resolveFlowAugmentedDeviceType({
        deviceClassKey: deviceClassKey!,
        targetCapabilityIds: [],
      })).toBe('unsupported');
    }
  });

  it('leaves a normal binary (non-battery) device UNCHANGED — still "binary"', () => {
    expect(resolveFlowAugmentedDeviceType({
      deviceClassKey: 'socket',
      targetCapabilityIds: [],
    })).toBe('binary');
  });

  it('leaves evcharger and temperature classification UNCHANGED', () => {
    expect(resolveFlowAugmentedDeviceType({
      deviceClassKey: 'evcharger',
      targetCapabilityIds: [],
    })).toBe('evcharger');
    expect(resolveFlowAugmentedDeviceType({
      deviceClassKey: 'heater',
      targetCapabilityIds: ['target_temperature'],
    })).toBe('unsupported');
  });
});
