import { describe, expect, it } from 'vitest';
import {
  type ExecutorDeviceReadDeps,
  readExecutorDevice,
  readExecutorDevices,
} from '../../lib/executor/executorDeviceRead';
import type { DeviceDescriptorRead } from '../../packages/contracts/src/types';
import type { ObserverDeviceRead } from '../../lib/executor/driftObservedDevice';
import { getBinaryControlPlan } from '../../lib/device/deviceActionProjection';
import { canTurnOnDevice } from '../../lib/plan/deviceCommandability';

// The executor's device is the transport's descriptor joined with the observer's
// record. These pin the join and nothing else: presence rules, precedence, and
// that the composed object carries both halves.

const descriptor = (id: string): DeviceDescriptorRead => ({
  id,
  name: `${id} (descriptor)`,
  deviceClass: 'heater',
  capabilities: ['onoff'],
  canSetControl: true,
  expectedPowerKw: 2,
  expectedPowerSource: 'manual',
});

const observed = (id: string): ObserverDeviceRead => ({
  id,
  name: `${id} (observed)`,
  targets: [],
  binaryControl: { on: true },
  available: true,
  reportedStepId: 'low',
  measuredPowerKw: 1.2,
});

const deps = (
  descriptors: DeviceDescriptorRead[],
  observedById: Record<string, ObserverDeviceRead>,
): ExecutorDeviceReadDeps => ({
  getDeviceDescriptor: (id) => descriptors.find((entry) => entry.id === id),
  getDeviceDescriptors: () => descriptors,
  getObservedState: (id) => observedById[id],
});

describe('readExecutorDevice', () => {
  it('joins the descriptor with the observed record, descriptor last', () => {
    const device = readExecutorDevice(deps([descriptor('a')], { a: observed('a') }), 'a');
    expect(device).toMatchObject({
      id: 'a',
      // Identity is the transport's: a rename arrives as a device.update with no
      // observed change, which the projection is not told about. (The fixture
      // names differ only to make the order visible.)
      name: 'a (descriptor)',
      deviceClass: 'heater',
      capabilities: ['onoff'],
      canSetControl: true,
      binaryControl: { on: true },
      available: true,
      reportedStepId: 'low',
      measuredPowerKw: 1.2,
    });
  });

  it('is undefined for a device the transport does not describe', () => {
    expect(readExecutorDevice(deps([], { a: observed('a') }), 'a')).toBeUndefined();
  });

  it('is undefined for a device the observer has not recorded', () => {
    expect(readExecutorDevice(deps([descriptor('a')], {}), 'a')).toBeUndefined();
  });

  it('admits a binary device for restore from the two halves alone — no currentOn rides along', () => {
    // `currentOn` is a plan-device decoration on neither surface. The raw
    // snapshot used to carry it into the executor by accident of being spread
    // whole; the admission gates must answer from `binaryControl` and the
    // descriptor's writeability, or a narrowed descriptor silently un-admits
    // every binary device.
    const device = readExecutorDevice(deps([descriptor('a')], { a: observed('a') }), 'a');
    expect(device).toBeDefined();
    expect('currentOn' in device!).toBe(false);
    expect(getBinaryControlPlan(device)).not.toBeNull();
    expect(canTurnOnDevice(device)).toBe(true);
  });
});

describe('readExecutorDevices', () => {
  it('keeps descriptor order and drops devices with no observed record', () => {
    const devices = readExecutorDevices(deps(
      [descriptor('a'), descriptor('b'), descriptor('c')],
      { a: observed('a'), c: observed('c') },
    ));
    expect(devices.map((device) => device.id)).toEqual(['a', 'c']);
  });
});
