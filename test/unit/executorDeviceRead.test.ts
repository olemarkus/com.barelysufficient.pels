import { describe, expect, it } from 'vitest';
import {
  type ExecutorDeviceReadDeps,
  readExecutorDevice,
  readExecutorDevices,
} from '../../lib/executor/executorDeviceRead';
import type { DeviceConfigurationRead } from '../../lib/device/deviceConfiguration';
import type { ObserverDeviceRead } from '../../lib/executor/driftObservedDevice';

// The executor joins runtime configuration with the observer's record.

const configuration = (id: string): DeviceConfigurationRead => ({
  id,
  name: `${id} (configuration)`,
  controlModel: 'binary_power',
  capabilities: ['onoff'],
  canSetControl: true,
  observeOnly: false,
  isEvCharger: false,
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
  configurations: DeviceConfigurationRead[],
  observedById: Record<string, ObserverDeviceRead>,
): ExecutorDeviceReadDeps => ({
  getDeviceConfiguration: (id) => configurations.find((entry) => entry.id === id),
  getDeviceConfigurations: () => configurations,
  getObservedState: (id) => observedById[id],
});

describe('readExecutorDevice', () => {
  it('joins runtime configuration with the observed record, configuration last', () => {
    const device = readExecutorDevice(deps([configuration('a')], { a: observed('a') }), 'a');
    expect(device).toMatchObject({
      id: 'a',
      // Identity comes from configuration; observation cannot overwrite it.
      name: 'a (configuration)',
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
    expect(readExecutorDevice(deps([configuration('a')], {}), 'a')).toBeUndefined();
  });

  it('keeps device writeability out of the executor read', () => {
    const device = readExecutorDevice(deps([configuration('a')], { a: observed('a') }), 'a');
    expect(device).toBeDefined();
    expect('currentOn' in device!).toBe(false);
    expect(device).not.toHaveProperty('capabilities');
    expect(device).not.toHaveProperty('canSetControl');
  });
});

describe('readExecutorDevices', () => {
  it('keeps configuration order and drops devices with no observed record', () => {
    const devices = readExecutorDevices(deps(
      [configuration('a'), configuration('b'), configuration('c')],
      { a: observed('a'), c: observed('c') },
    ));
    expect(devices.map((device) => device.id)).toEqual(['a', 'c']);
  });
});
