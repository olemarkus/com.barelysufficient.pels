import { describe, expect, it, vi } from 'vitest';
import { createDeviceReads, type DeviceReadStore } from '../../lib/device/deviceReads';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

const snapshot = (id: string, overrides: Record<string, unknown> = {}): TransportDeviceSnapshot => ({
  id,
  name: id,
  deviceClass: 'heater',
  capabilities: ['onoff'],
  expectedPowerKw: 2,
  expectedPowerSource: 'manual',
  targets: [],
  binaryControl: { on: true },
  available: true,
  binaryCapabilityId: 'onoff',
  ...overrides,
} as unknown as TransportDeviceSnapshot);

const storeOf = (devices: TransportDeviceSnapshot[]): DeviceReadStore => ({
  getSnapshot: () => devices,
  getSnapshotByDeviceId: (id) => devices.find((device) => device.id === id),
});

const readsOver = (devices: TransportDeviceSnapshot[]) => createDeviceReads(() => storeOf(devices));

describe('device reads', () => {
  it('serves inventory descriptors without runtime observations or transport fields', () => {
    const [device] = readsOver([snapshot('a')]).descriptors();
    expect(Object.keys(device!).sort()).toEqual([
      'binaryControllable', 'capabilities', 'deviceClass', 'deviceType', 'expectedPowerKw',
      'expectedPowerSource', 'id', 'isEvCharger', 'name', 'observeOnly',
    ]);
    expect(readsOver([snapshot('a')]).descriptor('a')).toEqual(device);
    expect(readsOver([snapshot('a')]).descriptor('missing')).toBeUndefined();
  });

  it('answers the production-candidate question without projecting a device', () => {
    const projectSpy = vi.fn();
    const devices = [snapshot('a'), snapshot('pv', { deviceClass: 'solarpanel' })];
    Object.defineProperty(devices[0]!, 'capabilities', { get: projectSpy });
    expect(readsOver(devices).hasProductionCandidate()).toBe(true);
    expect(projectSpy).not.toHaveBeenCalled();
  });

  it('joins zone membership from only the device id and zone id', () => {
    expect(readsOver([snapshot('a', { zoneId: 'z1' }), snapshot('b')]).zoneMemberships())
      .toEqual([{ deviceId: 'a', zoneId: 'z1' }, { deviceId: 'b', zoneId: null }]);
  });

  it('returns the tracked device ids', () => {
    expect(readsOver([snapshot('a'), snapshot('b')]).deviceIds()).toEqual(['a', 'b']);
  });
});
