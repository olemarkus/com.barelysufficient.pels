import { describe, expect, it } from 'vitest';
import { readDevicePowerSources } from '../../packages/shared-domain/src/settings/devicePowerSources';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { ExternalDevicePower, withExternalPowerCapability } from '../../lib/device/transport/externalDevicePower';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { TransportSnapshotStore } from '../../lib/device/transport/transportSnapshotStore';

const target = {
  ...HOMEY_DEVICE_FIELDS,
  id: 'heater', name: 'Heater', class: 'heater', available: true, zone: 'main',
  capabilities: ['onoff'],
  capabilitiesObj: { onoff: { value: true, lastUpdated: 1000, setable: true } },
} satisfies HomeyDeviceLike;

function socket(watts: number, on = true): HomeyDeviceLike {
  return {
    ...HOMEY_DEVICE_FIELDS,
    id: 'socket', name: 'Metering socket', class: 'socket', zone: 'main', available: true,
    capabilities: ['measure_power', 'onoff'],
    capabilitiesObj: {
      measure_power: { value: watts, lastUpdated: 2000 },
      onoff: { value: on, lastUpdated: 1000, setable: true },
    },
  };
}

function setup() {
  const inventory = new TransportSnapshotStore();
  const settings = {
    devicePowerSources: { heater: 'socket' },
    managedDevices: {} as Record<string, boolean>,
    isMainFusePhaseMeter: () => false,
  };
  const external = new ExternalDevicePower(settings, inventory, (_id, zone) => zone ?? undefined);
  return { inventory, external, settings };
}

describe('external device power', () => {
  it('rejects duplicate, self and chained assignments', () => {
    expect(readDevicePowerSources({ heater: 'socket', other: 'socket' })).toBeUndefined();
    expect(readDevicePowerSources({ heater: 'heater' })).toBeUndefined();
    expect(readDevicePowerSources({ heater: 'socket', socket: 'other' })).toBeUndefined();
    expect(readDevicePowerSources({ heater: 'socket', socket: null })).toBeUndefined();
  });

  it('uses socket watts with the original date, including a real zero', () => {
    const { inventory, external } = setup();
    const zero = socket(0);
    zero.capabilitiesObj.onoff = { value: true, lastUpdated: 3000, setable: true };
    inventory.replaceLatestRawDevices([target, zero], [target, zero]);
    expect(external.read(target)).toEqual({
      kind: 'external',
      socketId: 'socket',
      capability: { value: 0, lastUpdated: 2000 },
    });
    expect(withExternalPowerCapability(target, external.read(target))).toMatchObject({
      capabilities: ['onoff', 'measure_power'],
      capabilitiesObj: { measure_power: { value: 0, lastUpdated: 2000 } },
    });
    expect(external.allowsWrite('heater')).toBe(true);
    expect(external.allowsWrite('socket')).toBe(false);
  });

  it('does not offer last-resort control for an unmanaged socket with a real zero reading', () => {
    const { inventory, external } = setup();
    const source = socket(0);
    inventory.replaceLatestRawDevices([target, source], [target]);
    expect(external.readSetup().devices).toContainEqual(expect.objectContaining({
      id: 'socket', defaultBinarySwitchAvailable: true, lastResortAvailable: false,
    }));
  });

  it('withdraws the power capability if the socket turns off, is moved or is removed', () => {
    const { inventory, external } = setup();
    for (const source of [socket(500, false), { ...socket(500), zone: 'garage' }, undefined]) {
      const devices = source ? [target, source] : [target];
      inventory.replaceLatestRawDevices(devices, devices);
      expect(external.read(target)).toEqual({ kind: 'external', socketId: 'socket', capability: undefined });
      expect(withExternalPowerCapability(target, external.read(target))).toEqual(target);
      expect(external.allowsWrite('heater')).toBe(true);
      expect(external.allowsWrite('socket')).toBe(false);
    }
  });

  it('never attributes watts from a socket whose management setting conflicts', () => {
    const { inventory, external, settings } = setup();
    const source = socket(1800);
    settings.managedDevices = { socket: true };
    inventory.replaceLatestRawDevices([target, source], [target, source]);
    expect(external.read(target)).toEqual({ kind: 'external', socketId: 'socket', capability: undefined });
    expect(external.allowsWrite('socket')).toBe(false);
  });
});
