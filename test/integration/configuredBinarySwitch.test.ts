import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { getLogger } from '../../lib/logging/logger';
import { DEVICE_BINARY_SWITCHES } from '../../lib/utils/settingsKeys';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { celsius, homeyDevice, setable } from '../helpers/homeyDevicePayload';
import { emitCapability, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';

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
  settings = new DeviceControlSettings(mockHomeyInstance.settings);
  transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
    log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/configured-binary-switch'),
  }, {
    settings: {
      getBinarySwitchSelection: (id) => settings.getBinarySwitchSelection(id),
      getBinarySwitchRevision: (id) => settings.getBinarySwitchRevision(id),
      isBinarySwitchWriteCurrent: (id) => settings.isBinarySwitchWriteCurrent(id),
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
