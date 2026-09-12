import { describe, expect, it } from 'vitest';
import { projectDeviceDescriptor } from '../../lib/device/deviceDescriptorProjection';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

// The descriptor projection is what makes the executor's declared read the
// physical one: a full snapshot goes in, and only descriptor keys come out.

const snapshot = {
  id: 'dev-1',
  name: 'Heater',
  deviceClass: 'heater',
  capabilities: ['onoff', 'measure_power'],
  canSetControl: true,
  managed: true,
  expectedPowerKw: 2,
  expectedPowerSource: 'manual',
  steppedLoadProfile: { steps: [{ id: 'low', powerW: 500 }] },
  // Observed surface — must not survive the projection.
  targets: [{ id: 'target_temperature', value: 21 }],
  binaryControl: { on: true },
  available: true,
  reportedStepId: 'low',
  measuredPowerKw: 1.2,
  lastFreshDataMs: 1_000,
} as unknown as TargetDeviceSnapshot;

describe('projectDeviceDescriptor', () => {
  it('carries every defined descriptor key and no observed key', () => {
    const descriptor = projectDeviceDescriptor(snapshot);
    expect(Object.keys(descriptor).sort()).toEqual([
      'canSetControl',
      'capabilities',
      'deviceClass',
      'expectedPowerKw',
      'expectedPowerSource',
      'id',
      'managed',
      'name',
      'steppedLoadProfile',
    ]);
    expect(descriptor).not.toBe(snapshot);
  });

  it('leaves an undefined descriptor field absent rather than present-as-undefined', () => {
    const descriptor = projectDeviceDescriptor({ ...snapshot, zone: undefined });
    expect('zone' in descriptor).toBe(false);
  });
});
