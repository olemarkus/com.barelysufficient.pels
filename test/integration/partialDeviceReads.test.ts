import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { getLogger } from '../../lib/logging/logger';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { celsius, homeyDevice, setable } from '../helpers/homeyDevicePayload';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { mockHomeyInstance } from '../mocks/homey';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';

const BASE = Date.parse('2026-10-01T12:00:00Z');
const at = (minutes: number) => BASE + minutes * 60_000;
const stamp = (minutes: number) => new Date(at(minutes)).toISOString();

let transport: DeviceTransport;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
  transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
    log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/partial-device-reads'),
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

describe('cold reads with one unreadable control observation', () => {
  it('keeps a binary device and its measured power before the first switch reading', async () => {
    const initial = homeyDevice({ id: 'heater', name: 'Heater', class: 'heater' }, {
      onoff: setable(null), measure_power: 900,
    }, stamp(0));
    await seedTransportDevices(transport, [initial]);

    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      id: initial.id, available: true, measuredPowerKw: 0.9,
    });
    expect(transport.canTurnOnDevice(initial.id)).toBe(false);

    vi.setSystemTime(at(1));
    await emitCapability(initial.id, 'onoff', true);
    expect(transport.getSnapshotByDeviceId(initial.id)?.binaryControl?.on).toBe(true);
  });

  it('does not mark valid thermostat observations unavailable because its switch is unreadable', async () => {
    const initial = homeyDevice({ id: 'thermostat', name: 'Thermostat', class: 'thermostat', available: true }, {
      onoff: setable(null), measure_temperature: celsius(20), target_temperature: celsius(22), measure_power: 500,
    }, stamp(0));
    await seedTransportDevices(transport, [initial]);
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      available: true, measuredPowerKw: 0.5, temperature: { currentTemperature: 20, target: { value: 22 } },
    });
    expect(transport.canTurnOnDevice(initial.id)).toBe(false);
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
    await expect(transport.setCapability(initial.id, 'onoff', true)).rejects.toThrow('not ready');
    expect(put).not.toHaveBeenCalled();
    await transport.setCapability(initial.id, 'target_temperature', 23);
    expect(put).toHaveBeenCalledWith(
      `manager/devices/device/${initial.id}/capability/target_temperature`, pelsCapabilityWrite(23),
    );
  });

  it.each(['measure_temperature', 'target_temperature'])(
    'keeps thermostat power when %s has no first observation', async capabilityId => {
      const initial = homeyDevice({ id: 'thermostat', name: 'Thermostat', class: 'thermostat' }, {
        measure_temperature: celsius(20), target_temperature: celsius(21), measure_power: 900,
      }, stamp(0));
      await seedTransportDevices(transport, [{ ...initial, capabilitiesObj: {
        ...initial.capabilitiesObj,
        [capabilityId]: { ...initial.capabilitiesObj?.[capabilityId], value: null },
      } }]);

      expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({ id: initial.id, measuredPowerKw: 0.9 });
      expect(transport.getSnapshotByDeviceId(initial.id)?.temperature).toBeUndefined();
      expect(transport.canTurnOnDevice(initial.id)).toBe(false);

      await seedTransportDevices(transport, [initial]);
      expect(transport.getSnapshotByDeviceId(initial.id)?.temperature)
        .toMatchObject({ currentTemperature: 20, target: { value: 21 } });
    },
  );
});

describe('a declared native-current control without its descriptor', () => {
  it.each([true, false])('keeps Easee visible and preserves safe writes with native control %s', async (nativeEnabled) => {
    transport.destroy();
    transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
      log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/partial-device-reads'),
    }, { nativeWiring: { resolveNativeWiringEnabled: () => nativeEnabled } });
    await initWithLiveFeed(transport);
    const initial = homeyDevice({
      id: 'easee', name: 'Easee', class: 'evcharger', driverId: 'homey:app:no.easee:charger',
    }, {
      evcharger_charging: setable(true), evcharger_charging_state: 'plugged_in_paused',
      target_charger_current: setable(16), measure_power: 0,
    }, stamp(0));
    const { target_charger_current: _missingDescriptor, ...readableFields } = initial.capabilitiesObj;
    await seedTransportDevices(transport, [{ ...initial, capabilitiesObj: readableFields }]);

    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      id: initial.id, available: true, binaryControl: { on: true },
      evChargingState: 'plugged_in_paused', measuredPowerKw: 0,
    });
    expect(transport.getHomeyDeviceIds().has(initial.id)).toBe(true);
    expect(transport.canTurnOnDevice(initial.id)).toBe(!nativeEnabled);

    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
    await transport.setCapability(initial.id, 'evcharger_charging', false);
    expect(put).toHaveBeenCalledWith(
      `manager/devices/device/${initial.id}/capability/evcharger_charging`, pelsCapabilityWrite(false),
    );
    put.mockClear();
    if (nativeEnabled) {
      await expect(transport.setCapability(initial.id, 'evcharger_charging', true))
        .rejects.toThrow('Native power control metadata is unavailable');
      expect(put).not.toHaveBeenCalled();
    } else {
      await transport.setCapability(initial.id, 'evcharger_charging', true);
      expect(put).toHaveBeenCalledWith(
        `manager/devices/device/${initial.id}/capability/evcharger_charging`, pelsCapabilityWrite(true),
      );
    }
  });
});

describe('partial device reads after newer realtime observations', () => {
  it('retains target, measurement and thermal mode while accepting independent power', async () => {
    const initial = homeyDevice({ id: 'heat-pump', name: 'Heat pump', class: 'heatpump' }, {
      onoff: setable(true), target_temperature: celsius(21), measure_temperature: celsius(20),
      thermostat_mode: 'heat', measure_power: 500,
    }, stamp(0));
    await seedTransportDevices(transport, [initial]);

    vi.setSystemTime(at(1));
    await emitCapability(initial.id, 'target_temperature', 24);
    await emitCapability(initial.id, 'measure_temperature', 22);
    await emitCapability(initial.id, 'thermostat_mode', 'cool');
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      temperature: { currentTemperature: 22, target: { value: 24 } }, thermostatMode: 'cool',
    });

    vi.setSystemTime(at(2));
    emitDeviceUpdate({ ...initial, capabilitiesObj: {
      ...initial.capabilitiesObj,
      target_temperature: { value: 'unreadable', lastUpdated: stamp(2) },
      measure_temperature: { value: null, lastUpdated: stamp(2) },
      thermostat_mode: { value: null, lastUpdated: stamp(2) },
      measure_power: { value: 900, lastUpdated: stamp(2) },
    } });
    expect(transport.getSnapshot()).toHaveLength(1);
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      temperature: { currentTemperature: 22, target: { value: 24 } }, thermostatMode: 'cool',
      measuredPowerKw: 0.9, measuredPowerObservedAtMs: at(2),
    });

    // These source readings are newer than the accepted realtime reports but
    // older than the malformed frame's delivery. They must still win: rejecting
    // a field cannot re-stamp its retained value at the delivery time.
    vi.setSystemTime(at(3));
    await seedTransportDevices(transport, [{ ...initial, capabilitiesObj: {
      ...initial.capabilitiesObj,
      target_temperature: { value: 23, lastUpdated: stamp(1.5) },
      measure_temperature: { value: 21.5, lastUpdated: stamp(1.5) },
      thermostat_mode: { value: 'cool', lastUpdated: stamp(1.5) },
      measure_power: { value: 1000, lastUpdated: stamp(3) },
    } }]);
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      temperature: { currentTemperature: 21.5, target: { value: 23 } }, thermostatMode: 'cool',
      measuredPowerKw: 1, measuredPowerObservedAtMs: at(3),
    });
  });

  it('does not cache a realtime thermostat mode the mode owner rejected', async () => {
    const initial = homeyDevice({ id: 'heat-pump', name: 'Heat pump', class: 'heatpump' }, {
      onoff: setable(true), target_temperature: celsius(21), measure_temperature: celsius(20),
      thermostat_mode: 'heat', measure_power: 500,
    }, stamp(0));
    await seedTransportDevices(transport, [initial]);
    vi.setSystemTime(at(1));
    await emitCapability(initial.id, 'thermostat_mode', 'cool');
    vi.setSystemTime(at(1.5));
    await emitCapability(initial.id, 'thermostat_mode', '   ');
    expect(transport.getSnapshotByDeviceId(initial.id)?.thermostatMode).toBe('cool');

    vi.setSystemTime(at(2));
    emitDeviceUpdate({ ...initial, capabilitiesObj: {
      ...initial.capabilitiesObj,
      thermostat_mode: { value: null, lastUpdated: stamp(2) },
      measure_power: { value: 600, lastUpdated: stamp(2) },
    } });
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      thermostatMode: 'cool', measuredPowerKw: 0.6,
    });
  });

  it('keeps the charger battery level at its accepted source time through a malformed sibling read', async () => {
    const initial = homeyDevice({ id: 'charger', name: 'Charger', class: 'evcharger' }, {
      evcharger_charging: setable(true), evcharger_charging_state: 'plugged_in_charging',
      measure_battery: 40, measure_power: 7000,
    }, stamp(0));
    await seedTransportDevices(transport, [initial]);

    vi.setSystemTime(at(1));
    await emitCapability(initial.id, 'measure_battery', 45);
    expect(transport.getSnapshotByDeviceId(initial.id)?.stateOfCharge?.report)
      .toMatchObject({ percent: 45, observedAtMs: at(1) });

    vi.setSystemTime(at(2));
    emitDeviceUpdate({ ...initial, capabilitiesObj: {
      ...initial.capabilitiesObj,
      measure_battery: { value: null, lastUpdated: stamp(2) },
      measure_power: { value: 7100, lastUpdated: stamp(2) },
    } });
    expect(transport.getSnapshot()).toHaveLength(1);
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      evChargingState: 'plugged_in_charging', measuredPowerKw: 7.1, measuredPowerObservedAtMs: at(2),
      stateOfCharge: { report: { percent: 45, observedAtMs: at(1) } },
    });

    vi.setSystemTime(at(3));
    await seedTransportDevices(transport, [{ ...initial, capabilitiesObj: {
      ...initial.capabilitiesObj,
      measure_battery: { value: 46, lastUpdated: stamp(1.5) },
      measure_power: { value: 7200, lastUpdated: stamp(3) },
    } }]);
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      measuredPowerKw: 7.2,
      stateOfCharge: { report: { percent: 46, observedAtMs: at(1.5) } },
    });
  });

  it('retains a realtime native watt mode through a malformed mode update and the following pull', async () => {
    const base = buildZaptecTargetPowerDevice();
    const initial = buildZaptecTargetPowerDevice({ capabilitiesObj: {
      target_power: { ...base.capabilitiesObj?.target_power, value: 2760 },
      target_power_mode: { ...base.capabilitiesObj?.target_power_mode, value: 'homey' },
    } });
    await seedTransportDevices(transport, [initial]);

    vi.setSystemTime(at(1));
    await emitCapability(initial.id, 'target_power_mode', 'device');

    const unreadableMode = { ...initial, capabilitiesObj: {
      ...initial.capabilitiesObj,
      target_power_mode: { ...initial.capabilitiesObj?.target_power_mode, value: 'invalid', lastUpdated: stamp(2) },
      measure_power: { value: 7200, lastUpdated: stamp(2) },
    } };
    vi.setSystemTime(at(2));
    emitDeviceUpdate(unreadableMode);
    expect(transport.getSnapshotByDeviceId(initial.id)).toMatchObject({
      measuredPowerKw: 7.2, measuredPowerObservedAtMs: at(2),
    });

    vi.setSystemTime(at(3));
    await seedTransportDevices(transport, [unreadableMode]);
    const profile = transport.getSnapshotByDeviceId(initial.id)?.steppedLoadProfile;
    if (!profile) throw new Error('Expected native watt-control support to remain');
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
    await transport.requestSteppedLoadStep({
      deviceId: initial.id, profile, desiredStepId: '2530w', planningPowerW: 2530, planningCurrentA: 0,
    });
    // The last accepted mode was device, so a write must reclaim Homey control.
    // Keeping the stale initial homey field instead would silently omit this.
    expect(put.mock.calls.map(([path]) => path)).toEqual([
      `manager/devices/device/${initial.id}/capability/target_power`,
      `manager/devices/device/${initial.id}/capability/target_power_mode`,
    ]);
  });
});
