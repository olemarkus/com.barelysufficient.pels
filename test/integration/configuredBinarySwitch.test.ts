import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import { availableBinarySwitches } from '../../lib/device/transport/binarySwitchBinding';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { getLogger } from '../../lib/logging/logger';
import { DEVICE_BINARY_SWITCHES, LAST_RESORT_DEVICES, MANAGED_DEVICES } from '../../lib/utils/settingsKeys';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { celsius, homeyDevice, setable } from '../helpers/homeyDevicePayload';
import { emitCapability, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';

const ID = 'spa';
const HEATING = 'onoff.heating';
const PUMP = 'onoff.circulation';
const BASE = Date.parse('2026-10-01T12:00:00Z');
const switchFields = (heating = true) => ({
  [HEATING]: setable(heating),
  [PUMP]: setable(true),
  measure_power: 2000,
});
const spa = (nowMs = BASE, heating = true) => homeyDevice({ id: ID, name: 'Spa', class: 'thermostat' }, {
  ...switchFields(heating),
  onoff: setable(true),
  measure_temperature: celsius(38),
  target_temperature: celsius(40),
}, new Date(nowMs).toISOString());

let settings: DeviceControlSettings;
let lastResortDevices: Record<string, number>;
let transport: DeviceTransport;
const noFlow = vi.fn().mockRejectedValue(new Error('Unexpected Flow-backed switch'));

const configure = (switchId: string | undefined) => {
  mockHomeyInstance.settings.set(DEVICE_BINARY_SWITCHES, switchId ? { [ID]: switchId } : {});
  settings.reload();
};

beforeEach(async () => {
  resetMockHomey();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [ID]: true });
  settings = new DeviceControlSettings(mockHomeyInstance.settings);
  lastResortDevices = {};
  transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
    log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/configured-binary-switch'),
  }, {
    settings: {
      getBinarySwitchSelection: (id) => settings.getBinarySwitchSelection(id),
      getBinarySwitchRevision: (id) => settings.getBinarySwitchRevision(id),
      isBinarySwitchWriteCurrent: (id) => settings.isBinarySwitchWriteCurrent(id),
      lastResortDevices,
      isManaged: (id) => settings.isManaged(id),
    },
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

describe('configured binary switch', () => {
  it('offers and honors a Heatit relay switch alongside temperature control', async () => {
    const relay = 'onoff.relay';
    configure(relay);
    const thermostat = homeyDevice({
      id: ID, name: 'Floor heating', class: 'thermostat',
      ownerUri: 'homey:app:no.thermofloor', driverId: 'homey:app:no.thermofloor:Z-TRM6',
    }, {
      [relay]: setable(true),
      measure_temperature: celsius(20),
      target_temperature: celsius(22),
      measure_power: 2000,
    }, new Date(BASE).toISOString());

    expect(availableBinarySwitches(thermostat)).toEqual([{ id: relay, name: 'Relay' }]);
    await seedTransportDevices(transport, [thermostat]);
    expect(transport.getSnapshotByDeviceId(ID)).toMatchObject({
      binaryCapabilityId: relay, binaryControllable: true,
    });
  });

  it('admits an alternate-only load and writes the selected switch using its generation', async () => {
    configure(HEATING);
    const heater = homeyDevice({ id: ID, name: 'Heater', class: 'other' }, switchFields(), new Date(BASE).toISOString());
    await seedTransportDevices(transport, [heater]);
    const snapshot = transport.getSnapshotByDeviceId(ID);
    expect(snapshot).toMatchObject({ binaryCapabilityId: HEATING, binaryControllable: true, measuredPowerKw: 2 });
    const generation = snapshot?.binarySwitchGeneration;
    expect(generation).toBeGreaterThan(0);

    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
    await expect(transport.requestBinaryControl(ID, false, noFlow)).resolves.toBe(false);
    expect(put).not.toHaveBeenCalled();
    await transport.requestBinaryControl(ID, false, noFlow, generation);
    expect(put).toHaveBeenCalledExactlyOnceWith('manager/devices/device/spa/capability/onoff.heating', pelsCapabilityWrite(false));
  });

  it('restores its own OFF after a reading appears, then fences a running metered relay', async () => {
    lastResortDevices[ID] = 4000;
    mockHomeyInstance.settings.set(LAST_RESORT_DEVICES, lastResortDevices);
    settings.reload();
    const relay = (on: boolean, power: number) => homeyDevice(
      { id: ID, name: 'Relay', class: 'socket', energyObj: { W: 2000, approximation: { usageOn: 2000 } } },
      { onoff: setable(on), measure_power: power },
      new Date().toISOString(),
    );
    await seedTransportDevices(transport, [relay(true, 30_000)]);
    const snapshot = transport.getSnapshotByDeviceId(ID);
    expect(snapshot).toBeDefined();
    expect(snapshot && hasObservedMeasuredPower(snapshot)).toBe(false);
    const generation = snapshot?.binarySwitchGeneration;
    expect(generation).toBeGreaterThan(0);
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: (path) => mockHomeyInstance.api.get(path), put });
    await transport.requestBinaryControl(ID, false, noFlow, generation, 4000);
    expect(put).toHaveBeenCalledTimes(1);

    vi.setSystemTime(BASE + 1000);
    await seedTransportDevices(transport, [relay(false, 0)]);
    expect(transport.getSnapshotByDeviceId(ID)).toHaveProperty('measuredPowerKw', 0);
    setRestClient({ get: (path) => mockHomeyInstance.api.get(path), put });
    await transport.requestBinaryControl(ID, true, noFlow, generation, 4000);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(`manager/devices/device/${ID}/capability/onoff`, pelsCapabilityWrite(true));

    vi.setSystemTime(BASE + 2000);
    await seedTransportDevices(transport, [relay(true, 1500)]);
    setRestClient({ get: (path) => mockHomeyInstance.api.get(path), put });
    expect(transport.getSnapshotByDeviceId(ID)).toHaveProperty('measuredPowerKw', 1.5);
    await expect(transport.requestBinaryControl(ID, false, noFlow, generation, 4000)).resolves.toBe(false);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('never falls back to the main switch and confirms a dated selected echo', async () => {
    configure(HEATING);
    await seedTransportDevices(transport, [spa()]);
    const before = transport.getSnapshotByDeviceId(ID)?.binarySwitchGeneration ?? 0;
    expect(before).toBeGreaterThan(0);

    vi.setSystemTime(BASE + 1_000);
    await emitCapability(ID, HEATING, null);
    const rejected = transport.getSnapshotByDeviceId(ID);
    expect(rejected?.binaryCapabilityId).toBeUndefined();
    expect(rejected?.binaryControlObservation).toBeUndefined();
    expect(rejected?.temperature?.target.value).toBe(40);
    expect(rejected?.binarySwitchGeneration).toBeGreaterThan(before);
    await expect(transport.requestBinaryControl(ID, false, noFlow, before)).resolves.toBe(false);

    vi.setSystemTime(BASE + 2_000);
    await emitCapability(ID, HEATING, true);
    const recovered = transport.getSnapshotByDeviceId(ID);
    expect(recovered?.binaryCapabilityId).toBe(HEATING);
    expect(recovered?.binarySwitchGeneration).toBeGreaterThan(rejected?.binarySwitchGeneration ?? 0);
    const put = vi.fn().mockImplementation(async (_path, body: { transactionId: string }) => {
      await emitCapability(ID, HEATING, false, body.transactionId);
    });
    setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
    vi.setSystemTime(BASE + 3_000);
    await transport.requestBinaryControl(ID, false, noFlow, recovered?.binarySwitchGeneration);
    expect(transport.getBinaryCommandConfirmationSnapshot()).toContainEqual({
      id: ID, name: 'Spa', binarySwitchGeneration: recovered?.binarySwitchGeneration,
      binaryCommandConfirmation: { state: 'observed', observedValue: false, observedAtMs: BASE + 3_000 },
    });
  });

  it('uses the new switch own reading even when the old switch was observed later', async () => {
    await seedTransportDevices(transport, [spa(BASE + 1_000)]);
    configure(HEATING);
    await seedTransportDevices(transport, [spa(BASE, false)]);
    expect(transport.getSnapshotByDeviceId(ID)).toMatchObject({
      binaryCapabilityId: HEATING, binaryControl: { on: false },
      binaryControlObservation: { capabilityId: HEATING, observedValue: false, observedAtMs: BASE },
    });
  });

  it('retires both action and echo authority across A to B to A reconfiguration', async () => {
    configure(HEATING);
    await seedTransportDevices(transport, [spa()]);
    const before = transport.getSnapshotByDeviceId(ID)?.binarySwitchGeneration ?? 0;
    expect(before).toBeGreaterThan(0);

    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
    await transport.requestBinaryControl(ID, false, noFlow, before);
    const transactionId: string = put.mock.calls[0]?.[1].transactionId;

    configure(PUMP);
    await expect(transport.requestBinaryControl(ID, false, noFlow, before)).resolves.toBe(false);
    configure(HEATING);
    vi.setSystemTime(BASE + 2_000);
    emitDeviceUpdate(spa(BASE + 2_000));
    const after = transport.getSnapshotByDeviceId(ID)?.binarySwitchGeneration;
    expect(after).toBeGreaterThan(before);
    await expect(transport.requestBinaryControl(ID, false, noFlow, before)).resolves.toBe(false);
    await emitCapability(ID, HEATING, false, transactionId);
    expect(transport.getSnapshotByDeviceId(ID)).toMatchObject({
      binaryCapabilityId: HEATING, binaryControl: { on: true },
    });
    expect(put).toHaveBeenCalledTimes(1);
  });
});
