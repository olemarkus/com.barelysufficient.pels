import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { ObservedStateChangedEvent } from '../../lib/ports/observedStateEvents';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { getLogger } from '../../lib/logging/logger';
import { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import {
  createTestDeviceTransport, initWithLiveFeed, onObservedState, onObservedStateRefresh, seedTransportDevices,
} from '../helpers/deviceTransportHarness';
import { emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { celsius, homeyDevice, setable } from '../helpers/homeyDevicePayload';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { mockHomeyInstance } from '../mocks/homey';

const BASE = Date.parse('2026-10-01T12:00:00Z');
const at = (minute: number) => BASE + minute * 60_000;
const stamp = (minute: number) => new Date(at(minute)).toISOString();
const invalidKinds = ['null', 'wrong type', 'missing entry', 'undated', 'undeclared'] as const;
type InvalidKind = typeof invalidKinds[number];
const cases = (['cold', 'off', 'on'] as const).flatMap(prior => invalidKinds.map(kind => ({ prior, kind })));

let transport: DeviceTransport;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
  transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
    log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/rejected-binary-facet'),
  });
  await initWithLiveFeed(transport);
});

afterEach(() => {
  transport.destroy();
  vi.useRealTimers();
  setRestClient({
    get: path => mockHomeyInstance.api.get(path),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
});

function rejectOnOff(device: HomeyDeviceLike, kind: InvalidKind): HomeyDeviceLike {
  const { onoff, ...siblings } = device.capabilitiesObj ?? {};
  const rejectedValue = kind === 'wrong type' ? 'true' : null;
  return {
    ...device,
    capabilities: kind === 'undeclared' ? device.capabilities?.filter(id => id !== 'onoff') : device.capabilities,
    capabilitiesObj: kind === 'missing entry' ? siblings : {
      ...siblings,
      onoff: {
        ...onoff,
        value: kind === 'undated' || kind === 'undeclared' ? onoff?.value : rejectedValue,
        lastUpdated: kind === 'undated' ? null : onoff?.lastUpdated,
      },
    },
  };
}

describe.each(['refresh', 'device.update'] as const)('binary facet admission through %s', readPath => {
  it.each(cases)('keeps healthy temperature and power with $kind onoff after $prior', async ({ prior, kind }) => {
    const initial = homeyDevice({ id: 'hybrid', name: 'Hybrid thermostat', class: 'thermostat', available: true }, {
      onoff: setable(prior === 'on'), measure_temperature: celsius(20), target_temperature: celsius(22),
      measure_power: 500,
    }, stamp(0));
    if (prior !== 'cold') await seedTransportDevices(transport, [initial]);

    vi.setSystemTime(at(2));
    const next = rejectOnOff(homeyDevice({
      id: initial.id, name: initial.name, class: initial.class, available: true,
    }, {
      onoff: setable(true), measure_temperature: celsius(21), target_temperature: celsius(23), measure_power: 900,
    }, stamp(2)), kind);
    if (readPath === 'refresh') await seedTransportDevices(transport, [next]);
    else emitDeviceUpdate(next);

    const snapshot = transport.getSnapshotByDeviceId(initial.id);
    expect(snapshot).toMatchObject({
      available: true, measuredPowerKw: 0.9, measuredPowerObservedAtMs: at(2),
      temperature: { currentTemperature: 21, target: { value: 23 } }, binaryControllable: false,
    });
    expect(snapshot?.binaryCapabilityId).toBeUndefined();
    expect(snapshot?.binaryControl).toBeUndefined();
    expect(snapshot?.binaryControlObservation).toBeUndefined();
    expect(transport.getBinarySettleEvidenceByDeviceId(initial.id)).toBeUndefined();
    expect(snapshot?.capabilities).not.toContain('onoff');
    expect(transport.canTurnOnDevice(initial.id)).toBe(false);

    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
    for (const value of [true, false]) {
      await expect(transport.setCapability(initial.id, 'onoff', value))
        .rejects.toThrow('Binary control is unavailable');
    }
    expect(put).not.toHaveBeenCalled();
    await transport.setCapability(initial.id, 'target_temperature', 24);
    expect(put).toHaveBeenCalledWith(
      `manager/devices/device/${initial.id}/capability/target_temperature`, pelsCapabilityWrite(24),
    );

    vi.setSystemTime(at(3));
    await seedTransportDevices(transport, [homeyDevice({ id: initial.id, name: initial.name, class: initial.class }, {
      onoff: setable(true), measure_temperature: celsius(21), target_temperature: celsius(23), measure_power: 900,
    }, stamp(3))]);
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      binaryCapabilityId: 'onoff', binaryControllable: true, binaryControl: { on: true },
      binaryControlObservation: { observedValue: true, observedAtMs: at(3) },
    });
  });
});

it('keeps unmetered temperature functionality when onoff is rejected', async () => {
  await seedTransportDevices(transport, [homeyDevice({
    id: 'unmetered', name: 'Unmetered thermostat', class: 'thermostat', available: true,
  }, {
    onoff: setable(null), measure_temperature: celsius(20), target_temperature: celsius(22),
  }, stamp(0))]);
  expect(transport.getSnapshotByDeviceId('unmetered')).toMatchObject({
    available: true, temperature: { currentTemperature: 20, target: { value: 22 } }, binaryControllable: false,
  });
  expect(transport.getSnapshotByDeviceId('unmetered')?.binaryControl).toBeUndefined();
  expect(transport.getSnapshotByDeviceId('unmetered')?.measuredPowerKw).toBeUndefined();
});

it('publishes binary removal and restoration when all healthy sibling readings are unchanged', async () => {
  const initial = homeyDevice({ id: 'hybrid', name: 'Hybrid thermostat', class: 'thermostat', available: true }, {
    onoff: setable(true), measure_temperature: celsius(20), target_temperature: celsius(22), measure_power: 500,
  }, stamp(0));
  await seedTransportDevices(transport, [initial]);
  const changed = vi.fn<(event: ObservedStateChangedEvent) => void>();
  onObservedState(transport, changed);

  vi.setSystemTime(at(1));
  emitDeviceUpdate(rejectOnOff(initial, 'null'));
  expect(changed).toHaveBeenCalled();
  expect(changed.mock.calls.at(-1)?.[0].observed).toMatchObject({ id: initial.id, available: true });
  expect(changed.mock.calls.at(-1)?.[0].observed).not.toHaveProperty('binaryControl');
  expect(changed.mock.calls.at(-1)?.[0].observed).not.toHaveProperty('binaryControlObservation');
  expect(transport.getSnapshotByDeviceId(initial.id)?.binaryControl).toBeUndefined();

  changed.mockClear();
  vi.setSystemTime(at(2));
  emitDeviceUpdate({ ...initial, capabilitiesObj: {
    ...initial.capabilitiesObj,
    onoff: { ...initial.capabilitiesObj.onoff, lastUpdated: stamp(2) },
  } });
  expect(changed).toHaveBeenCalled();
  expect(changed.mock.calls.at(-1)?.[0].observed).toMatchObject({
    id: initial.id, binaryControl: { on: true }, binaryControlObservation: { observedValue: true },
  });
});

it('keeps genuine native watt control when the binary field is rejected', async () => {
  transport.destroy();
  transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
    log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/rejected-binary-facet'),
  }, { nativeWiring: { resolveNativeWiringEnabled: () => true } });
  await initWithLiveFeed(transport);
  const base = buildZaptecTargetPowerDevice();
  const device = buildZaptecTargetPowerDevice({
    capabilities: [...(base.capabilities ?? []), 'onoff'],
    capabilitiesObj: homeyDevice(base, {
      evcharger_charging: setable(null), onoff: setable(true),
    }, stamp(0)).capabilitiesObj,
  });
  await seedTransportDevices(transport, [device]);
  const snapshot = transport.getSnapshotByDeviceId(device.id);
  expect(snapshot?.steppedLoadProfile).toBeDefined();
  expect(snapshot?.controlAdapter).toMatchObject({
    kind: 'capability_adapter', activationAvailable: false, activationEnabled: true,
  });
  expect(snapshot?.nativeWriteCapabilities).toContain('target_power');
  expect(snapshot?.binaryCapabilityId).toBeUndefined();
  expect(snapshot?.binaryControl).toBeUndefined();
  expect(snapshot?.capabilities).not.toContain('onoff');
  expect(snapshot?.evChargingState).toBeDefined();
  const profile = snapshot?.steppedLoadProfile;
  if (!profile) throw new Error('Expected the independent native control facet');
  const put = vi.fn().mockResolvedValue(undefined);
  setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
  await expect(transport.requestSteppedLoadStep({
    deviceId: device.id, profile, desiredStepId: '2530w', planningPowerW: 2530, planningCurrentA: 0,
  })).resolves.toEqual({ requested: true, acknowledged: true, transport: 'native_capability' });
  expect(put).toHaveBeenCalledWith(
    `manager/devices/device/${device.id}/capability/target_power`, pelsCapabilityWrite(2530),
  );
  expect(put.mock.calls.some(([path]) => /\/capability\/(onoff|evcharger_charging)$/u.test(path))).toBe(false);
});

it('withdraws an omitted device from Observer without refreshing unrelated devices', async () => {
  const projection = new ObservedDeviceStateProjection();
  const changed = vi.fn<(event: ObservedStateChangedEvent) => void>();
  onObservedState(transport, event => { projection.applyDelta(event); changed(event); });
  onObservedStateRefresh(transport, event => projection.applyRefresh(event));
  const initial = homeyDevice({ id: 'binary-only', name: 'Heater', class: 'heater', available: true }, {
    onoff: setable(true), measure_power: 500,
  }, stamp(0));
  const other = homeyDevice({ id: 'other', name: 'Other heater', class: 'heater', available: true }, {
    onoff: setable(false), measure_power: 0,
  }, stamp(0));
  await seedTransportDevices(transport, [initial, other]);
  const unrelatedBefore = projection.getObservedState(other.id);
  const revisionBefore = projection.getRevision();
  expect(projection.getObservedState(initial.id)?.binaryControl).toEqual({ on: true });

  vi.setSystemTime(at(1));
  emitDeviceUpdate(rejectOnOff(initial, 'null'));
  expect(transport.getSnapshotByDeviceId(initial.id)).toBeUndefined();
  expect(projection.getObservedState(initial.id)).toBeUndefined();
  expect(projection.getRevision()).toBeGreaterThan(revisionBefore);
  expect(projection.getObservedState(other.id)).toBe(unrelatedBefore);
  expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ deviceId: initial.id, removed: true });
  expect(changed.mock.calls.at(-1)?.[0]).not.toHaveProperty('observed');

  vi.setSystemTime(at(2));
  emitDeviceUpdate({ ...initial, capabilitiesObj: {
    ...initial.capabilitiesObj,
    onoff: { ...initial.capabilitiesObj.onoff, lastUpdated: stamp(2) },
  } });
  expect(projection.getObservedState(initial.id)?.binaryControl).toEqual({ on: true });
  expect(projection.getObservedState(other.id)).toBe(unrelatedBefore);
});

it('does not publish removal for an untracked update that leaves the committed snapshot unchanged', async () => {
  transport.destroy();
  const isManaged = vi.fn().mockReturnValue(true);
  transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
    log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/rejected-binary-facet'),
  }, { settings: { isManaged } });
  await initWithLiveFeed(transport);
  const projection = new ObservedDeviceStateProjection();
  const changed = vi.fn<(event: ObservedStateChangedEvent) => void>();
  onObservedState(transport, event => { projection.applyDelta(event); changed(event); });
  onObservedStateRefresh(transport, event => projection.applyRefresh(event));
  const initial = homeyDevice({ id: 'heater', name: 'Heater', class: 'heater', available: true }, {
    onoff: setable(true), measure_power: 500,
  }, stamp(0));
  await seedTransportDevices(transport, [initial]);
  const before = projection.getObservedState(initial.id);
  isManaged.mockReturnValue(false);

  emitDeviceUpdate(initial);

  expect(transport.getSnapshotByDeviceId(initial.id)?.binaryControl).toEqual({ on: true });
  expect(projection.getObservedState(initial.id)).toBe(before);
  expect(changed.mock.calls.some(([event]) => event.removed === true)).toBe(false);
});
