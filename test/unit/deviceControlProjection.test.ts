import { describe, expect, it } from 'vitest';
import {
  decorateSnapshotWithDeviceControl,
  type DeviceControlProjectionSource,
} from '../../lib/planInput/deviceControlProjection';
import { steppedStoresForTest } from '../helpers/steppedStores';

const snapshot: DeviceControlProjectionSource = {
  available: true,
  id: 'dev-1',
  name: 'Water heater',
  targets: [],
  deviceType: 'onoff',
  controlModel: 'stepped_load',
  binaryControl: { on: false },
  expectedPowerKw: 1,
  expectedPowerSource: 'default',
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'max', planningPowerW: 3000 },
    ],
  },
};

describe('resolved device control projection', () => {
  it('retains owner-admitted step truth while the binary axis is off', () => {
    const { store } = steppedStoresForTest();
    store.markDesiredStepIssued({ deviceId: 'dev-1', desiredStepId: 'low', issuedAtMs: 1_000 });

    const decorated = decorateSnapshotWithDeviceControl({
      ...snapshot,
      reportedStepId: 'max', reportedStepPowerW: 3000, reportedStepObservedAtMs: 1500,
      expectedPowerKw: 2.2, expectedPowerSource: 'manual' as const,
    }, store, false, false);

    expect(decorated).toMatchObject({
      reportedStepId: 'max', selectedStepId: 'max', desiredStepId: 'low',
      binaryControl: { on: false }, planningPowerKw: 3,
      stepCommandPending: true, stepCommandStatus: 'pending',
      expectedPowerKw: 2.2, expectedPowerSource: 'manual',
    });
    expect(store.getDesired('dev-1')?.status).toBe('pending');
  });

  it('uses the lowest active resolved rung when telemetry supplies no step', () => {
    const { store } = steppedStoresForTest();
    const decorated = decorateSnapshotWithDeviceControl({
      ...snapshot, binaryControl: { on: true }, measuredPowerKw: 3, selectedStepId: 'max',
    }, store, false, false);

    expect(decorated).toMatchObject({ selectedStepId: 'low', planningPowerKw: 1.25 });
    expect(decorated.reportedStepId).toBeUndefined();
  });

  it('keeps a device with no resolved ladder on its owner-selected control axis', () => {
    const { store } = steppedStoresForTest();
    const decorated = decorateSnapshotWithDeviceControl({
      ...snapshot, steppedLoadProfile: undefined, controlModel: 'binary_power',
    }, store, false, false);

    expect(decorated.controlModel).toBe('binary_power');
    expect(decorated.steppedLoadProfile).toBeUndefined();
    expect(decorated.selectedStepId).toBeUndefined();
  });
});
