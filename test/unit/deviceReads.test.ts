import { describe, expect, it, vi } from 'vitest';
import { createDeviceReads, type DeviceReadStore } from '../../lib/device/deviceReads';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

// The one owner of device reads. These pin the two things it owns beyond
// delegating to the projections: what each read PHYSICALLY carries, and what an
// absent transport means — which is deliberately not one answer.

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
  measuredPowerKw: 1.5,
  // Transport-internal: must reach no consumer.
  binaryCapabilityId: 'onoff',
  ...overrides,
} as unknown as TransportDeviceSnapshot);

const storeOf = (devices: TransportDeviceSnapshot[]): DeviceReadStore => ({
  getSnapshot: () => devices,
  getSnapshotByDeviceId: (id) => devices.find((device) => device.id === id),
  getUiPickerDevices: () => devices,
});

const readsOver = (
  devices: TransportDeviceSnapshot[],
  observed: Record<string, ProjectedObservedDeviceState> = {},
) => createDeviceReads({
  getStore: () => storeOf(devices),
  getObservedRecord: (deviceId) => observed[deviceId],
});

describe('device reads', () => {
  it('serves descriptors that carry no observation and no transport binding', () => {
    const [device] = readsOver([snapshot('a')]).descriptors();
    expect(Object.keys(device!).sort()).toEqual([
      'capabilities', 'deviceClass', 'expectedPowerKw', 'expectedPowerSource', 'id', 'name',
    ]);
  });

  it('serves surfaces that carry both halves and no transport binding', () => {
    const [device] = readsOver([snapshot('a')]).surfaces();
    expect(device).toMatchObject({ id: 'a', deviceClass: 'heater', binaryControl: { on: true } });
    expect('binaryCapabilityId' in device!).toBe(false);
  });

  it('is COMPLETE: an unrecorded device falls back to the snapshot, clusters and all', () => {
    // Dropping it would reach `cleanupMissingHeadroomDevices`, which treats an
    // absent device as one that left the home and discards its held-time
    // accounting, surplus eligibility and rung tracking. The cluster assertion is
    // the second half: those fields live on the probes, and reading them through
    // a narrower store type is how a later narrowing would empty them silently.
    const record = { ...snapshot('a') } as unknown as ProjectedObservedDeviceState;
    const surfaces = readsOver([snapshot('a'), snapshot('b'), snapshot('c')], { a: record, c: record })
      .surfaces();
    expect(surfaces.map((device) => device.id)).toEqual(['a', 'b', 'c']);
    expect(surfaces[1]).toMatchObject({ id: 'b', measuredPowerKw: 1.5, binaryControl: { on: true } });
  });

  it('prefers the observer record over the snapshot for the observed half', () => {
    const record = { ...snapshot('a'), measuredPowerKw: 9 } as unknown as ProjectedObservedDeviceState;
    const [device] = readsOver([snapshot('a')], { a: record }).surfaces();
    expect(device?.measuredPowerKw).toBe(9);
  });

  it('answers the production-candidate question without projecting a device', () => {
    const projectSpy = vi.fn();
    const devices = [snapshot('a'), snapshot('pv', { deviceClass: 'solarpanel' })];
    // A getter that would fire if any read touched a device's fields.
    Object.defineProperty(devices[0]!, 'capabilities', { get: projectSpy });
    expect(readsOver(devices).hasProductionCandidate()).toBe(true);
    expect(projectSpy).not.toHaveBeenCalled();
  });

  it('joins zone membership from two fields only', () => {
    expect(readsOver([snapshot('a', { zoneId: 'z1' }), snapshot('b')]).zoneMemberships())
      .toEqual([{ deviceId: 'a', zoneId: 'z1' }, { deviceId: 'b', zoneId: null }]);
  });

  describe('an absent transport', () => {
    const absent = createDeviceReads({ getStore: () => undefined, getObservedRecord: () => undefined });

    // The policy is per-read and derived from the CALLER's context, not from the
    // read's shape — arity does not predict it, which is the point of pinning all
    // three arms here.
    it('resolves reads whose callers run before wiring and cannot surface a throw', () => {
      expect(absent.descriptors()).toEqual([]);
      expect(absent.surfaces()).toEqual([]);
      expect(absent.observedSeed()).toEqual([]);
      expect(absent.deviceIds()).toEqual([]);
      expect(absent.zoneMemberships()).toEqual([]);
      expect(absent.pickerSurfaces()).toEqual([]);
      // By-id, but its caller is the shed-behaviour thunk, which already handles
      // an absent device and cannot report a boot-order error.
      expect(absent.surface('a')).toBeUndefined();
    });

    it('throws where resolving would be a decision silently never applied', () => {
      // The executor's read: "untracked device" here is a plan decided and never
      // applied.
      expect(() => absent.descriptor('a')).toThrow(/must be initialized/);
      // A whole-corpus read that still throws: resolving would answer "this home
      // produces nothing" and suppress production polling forever.
      expect(() => absent.hasProductionCandidate()).toThrow(/must be initialized/);
    });
  });
});
