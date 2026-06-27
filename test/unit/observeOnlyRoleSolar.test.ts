import { describe, expect, it } from 'vitest';
import { resolveFlowAugmentedDeviceType } from '../../lib/device/transport/flowReportedCapabilities';
import { resolveDeviceClassKey } from '../../lib/device/transport/managerHelpers';
import { shouldDropAfterControlState, type ManagedFilterDecision } from '../../lib/device/transport/managerManagedFilter';
import type { HomeyDeviceLike } from '../../lib/utils/types';

// A solar device is MANAGED OBSERVE-ONLY, exactly like a battery: PELS never controls
// it. These lock the four shared parse seams for the solar role.
const managedDecision: ManagedFilterDecision = { hasOracle: true, filterActive: true, isManaged: true };

describe('resolveDeviceClassKey — solar normalization (detection == survival)', () => {
  it('normalizes a class:solarpanel device to the "solarpanel" class-key', () => {
    const dev: HomeyDeviceLike = {
      id: 's1', name: 'Solar', class: 'solarpanel', capabilities: ['measure_power', 'meter_power'],
    };
    expect(resolveDeviceClassKey(dev)).toBe('solarpanel');
  });

  it('does NOT normalize a non-solar grid meter (export cap, class:sensor) to "solarpanel"', () => {
    const grid: HomeyDeviceLike = {
      id: 'grid', name: 'Grid meter', class: 'sensor',
      energy: { meterPowerExportedCapability: 'meter_power.exported' },
      capabilities: ['measure_power'],
    };
    // FIX 1: the export property is NOT the solar identity gate. A class:'sensor' meter
    // is not in the supported set and is not solar, so it resolves to null (dropped),
    // never to 'solarpanel'.
    expect(resolveDeviceClassKey(grid)).toBeNull();
  });

  it('leaves a non-solar supported class unchanged', () => {
    expect(resolveDeviceClassKey({ id: 'h', name: 'Heater', class: 'heater' })).toBe('heater');
  });
});

describe('resolveFlowAugmentedDeviceType — solar exclusion', () => {
  it('returns "unsupported" for a solarpanel class-key (never "binary")', () => {
    expect(resolveFlowAugmentedDeviceType({ deviceClassKey: 'solarpanel', targetCapabilityIds: [] }))
      .toBe('unsupported');
  });

  it('returns "unsupported" for a class:solarpanel device via its normalized class-key', () => {
    const classSolar: HomeyDeviceLike = {
      id: 's1', name: 'Solar', class: 'solarpanel', capabilities: ['measure_power'],
    };
    const deviceClassKey = resolveDeviceClassKey(classSolar);
    expect(deviceClassKey).toBe('solarpanel');
    expect(resolveFlowAugmentedDeviceType({ deviceClassKey: deviceClassKey!, targetCapabilityIds: [] }))
      .toBe('unsupported');
  });

  it('leaves a normal binary (non-solar) device UNCHANGED — still "binary"', () => {
    expect(resolveFlowAugmentedDeviceType({ deviceClassKey: 'socket', targetCapabilityIds: [] })).toBe('binary');
  });
});

describe('shouldDropAfterControlState — solar device', () => {
  it('KEEPS a solar device on the runtime path despite undefined currentOn', () => {
    expect(shouldDropAfterControlState({
      purpose: 'runtime', decision: managedDecision, currentOn: undefined, deviceClassKey: 'solarpanel',
    })).toBe(false);
  });

  it('DROPS a solar device from the ui_picker (its "manage" toggle is a no-op)', () => {
    expect(shouldDropAfterControlState({
      purpose: 'ui_picker', decision: managedDecision, currentOn: undefined, deviceClassKey: 'solarpanel',
    })).toBe(true);
  });

  it('still drops a NON-observe-only device with undefined currentOn on the runtime path (unchanged)', () => {
    expect(shouldDropAfterControlState({
      purpose: 'runtime', decision: managedDecision, currentOn: undefined, deviceClassKey: 'heater',
    })).toBe(true);
  });
});
