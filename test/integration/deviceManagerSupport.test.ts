import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { Logger } from '../../lib/utils/types';
import {
  getCanSetControl,
  getControlCapabilityId,
  getEvCharging,
  getCurrentOn,
  getEvChargingState,
  logEvCapabilityAccepted,
  logEvCapabilityRequest,
  logEvSnapshotChanges,
} from '../../lib/device/managerControl';
import {
  buildTargets,
  getExactPowerCapabilityValue,
  getCurrentTemperature,
  resolveDeviceCapabilities,
} from '../../lib/device/transport/managerParse';
import { getBinaryControlPlan } from '../../lib/plan/planBinaryControl';
import {
  reconcileRealtimeDeviceUpdate,
  updateLastKnownPower,
} from '../../lib/device/managerRuntime';
import {
  getRawDevice,
  getRawDevices,
  hasRestClient,
  logDeviceTransportRuntimeError,
  resetRestClient,
  setRawCapabilityValue,
  setRestClient,
  writeErrorToStderr,
} from '../../lib/device/transport/managerHomeyApi';
import { fetchDevicesByIds } from '../../lib/device/transport/managerFetch';

const createLogger = () => ({
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: {
    debug: vi.fn(),
  },
}) as unknown as Logger & {
  log: vi.Mock;
  debug: vi.Mock;
  error: vi.Mock;
};

const mockRestClient = { get: vi.fn(), put: vi.fn() };

describe('device manager support helpers', () => {
  beforeEach(() => {
    mockRestClient.get.mockClear();
    mockRestClient.put.mockClear();
    setRestClient(mockRestClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRestClient();
  });

  it('resolves EV control capability and charging state helpers', () => {
    const capabilityObj = {
      evcharger_charging: { value: false, setable: true },
      evcharger_charging_state: { value: 'plugged_in_paused' },
      onoff: { value: true, setable: false },
      measure_temperature: { value: 21 },
      target_temperature: { value: 22, units: 'C', min: 35, max: 75, step: 5 },
    };

    expect(getControlCapabilityId({ deviceClassKey: 'evcharger', capabilities: ['onoff', 'evcharger_charging'] })).toBe('evcharger_charging');
    expect(getControlCapabilityId({ deviceClassKey: 'socket', capabilities: ['onoff'] })).toBe('onoff');
    expect(getCurrentOn({ deviceClassKey: 'evcharger', capabilityObj, controlCapabilityId: 'evcharger_charging' })).toBe(false);
    expect(getCurrentOn({
      deviceClassKey: 'evcharger',
      capabilityObj: { evcharger_charging_state: { value: 'plugged_in_paused' } },
      controlCapabilityId: 'evcharger_charging',
    })).toBe(false);
    expect(getCurrentOn({
      deviceClassKey: 'evcharger',
      capabilityObj: { evcharger_charging_state: { value: 'plugged_in_charging' } },
      controlCapabilityId: 'evcharger_charging',
    })).toBe(true);
    // State-authoritative: the charge-state string wins over the raw
    // `evcharger_charging` boolean. A paused charger is off (held off —
    // commandable, but not on) even if the boolean still reads `true`.
    expect(getCurrentOn({
      deviceClassKey: 'evcharger',
      capabilityObj: {
        evcharger_charging: { value: true },
        evcharger_charging_state: { value: 'plugged_in_paused' },
      },
      controlCapabilityId: 'evcharger_charging',
    })).toBe(false);
    expect(getCurrentOn({
      deviceClassKey: 'socket',
      capabilityObj: { onoff: { value: true } },
      controlCapabilityId: 'onoff',
    })).toBe(true);
    expect(getCanSetControl('evcharger_charging', capabilityObj)).toBe(true);
    expect(getCanSetControl('onoff', capabilityObj)).toBe(false);
    expect(getEvCharging(capabilityObj)).toBe(false);
    expect(getEvChargingState(capabilityObj)).toBe('plugged_in_paused');
    expect(getCurrentTemperature(capabilityObj)).toBe(21);
    expect(buildTargets({
      targetCaps: ['target_temperature'],
      capabilityObj,
      deviceLabel: 'Device',
    })).toEqual([{
      id: 'target_temperature',
      value: 22,
      unit: 'C',
      min: 35,
      max: 75,
      step: 5,
    }]);

    const debugStructured = vi.fn();
    expect(buildTargets({
      targetCaps: ['target_temperature'],
      capabilityObj: {
        target_temperature: { value: 'invalid', units: 'C', min: 35, max: 75, step: 5 },
      },
      deviceId: 'broken-device',
      deviceLabel: 'Broken Device',
      debugStructured,
    })).toEqual([{
      id: 'target_temperature',
      unit: 'C',
      min: 35,
      max: 75,
      step: 5,
    }]);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'target_capability_value_malformed',
      deviceId: 'broken-device',
      deviceName: 'Broken Device',
      capabilityId: 'target_temperature',
      rawValue: 'invalid',
    }));
  });

  it('logs EV command and snapshot changes', () => {
    const logger = createLogger();
    const previousSnapshot: TargetDeviceSnapshot[] = [
      { id: 'ev1', name: 'EV 1', deviceClass: 'evcharger', binaryControl: { on: false }, evChargingState: 'plugged_in_paused', powerKw: 0, controlCapabilityId: 'evcharger_charging' },
    ];
    const nextSnapshot: TargetDeviceSnapshot[] = [
      { id: 'ev1', name: 'EV 1', deviceClass: 'evcharger', binaryControl: { on: true }, evChargingState: 'plugged_in_charging', powerKw: 7.2, controlCapabilityId: 'evcharger_charging' },
      { id: 'ev2', name: 'EV 2', deviceClass: 'evcharger', binaryControl: { on: false }, evChargingState: 'plugged_out', powerKw: 0, controlCapabilityId: 'evcharger_charging' },
    ];

    logEvCapabilityRequest({
      logger,
      snapshotBefore: previousSnapshot[0],
      deviceId: 'ev1',
      capabilityId: 'evcharger_charging',
      value: true,
    });
    logEvCapabilityAccepted({
      logger,
      snapshotAfter: nextSnapshot[0],
      deviceId: 'ev1',
      capabilityId: 'evcharger_charging',
      value: true,
    });
    logEvSnapshotChanges({ logger, previousSnapshot, nextSnapshot });
    logEvSnapshotChanges({ logger, previousSnapshot: nextSnapshot, nextSnapshot: [nextSnapshot[0]] });

    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'ev_command_requested' }));
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'ev_command_accepted' }));
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'ev_snapshot_changed', deviceName: 'EV 1' }));
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'ev_snapshot_discovered', deviceName: 'EV 2' }));
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'ev_snapshot_removed', deviceName: 'EV 2' }));
  });

  it('resolves device parse capabilities and power capability lookup', () => {
    const debugStructured = vi.fn();
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'evcharger',
      deviceId: 'ev1',
      deviceLabel: 'EV 1',
      capabilities: ['measure_power'],
      debugStructured,
    })).toBeNull();
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_skipped_missing_capability',
      deviceId: 'ev1',
      missingCapability: 'evcharger_charging',
    }));
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'evcharger',
      deviceId: 'ev2',
      deviceLabel: 'EV 2',
      capabilities: ['evcharger_charging', 'measure_power'],
      debugStructured,
    })).toBeNull();
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_skipped_missing_capability',
      deviceId: 'ev2',
      missingCapability: 'evcharger_charging_state',
    }));
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'heater',
      deviceId: 'heater1',
      deviceLabel: 'Heater',
      capabilities: ['measure_temperature', 'target_temperature', 'measure_power'],
    })).toEqual({ targetCaps: ['target_temperature'], hasPower: true });
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'socket',
      deviceId: 'socket1',
      deviceLabel: 'Socket',
      capabilities: ['measure_power', 'onoff'],
    })).toEqual({ targetCaps: [], hasPower: true });
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'socket',
      deviceId: 'socket2',
      deviceLabel: 'Socket 2',
      capabilities: ['measure_power.internal', 'onoff'],
    })).toEqual({ targetCaps: [], hasPower: false });
    expect(getExactPowerCapabilityValue(
      ['measure_power'],
      { measure_power: { value: 400 } },
      'measure_power',
    )).toBe(400);
    expect(getExactPowerCapabilityValue(
      ['measure_power.internal'],
      { 'measure_power.internal': { value: 400 } },
      'measure_power',
    )).toBeUndefined();
  });

  it('updates runtime device manager power state helpers', async () => {
    const logger = createLogger();
    const state = {
      lastKnownPowerKw: { dev1: 0.5 },
      lastPeakPowerLogByDevice: new Map(),
    };
    updateLastKnownPower({ state, logger, deviceId: 'dev1', measuredKw: 1.2, deviceLabel: 'Device 1' });
    expect(state.lastKnownPowerKw.dev1).toBe(1.2);

    const mockGet = vi.fn().mockResolvedValue([{ id: 'direct' }]);
    setRestClient({ get: mockGet, put: vi.fn() });
    await expect(getRawDevices('devices')).resolves.toEqual([{ id: 'direct' }]);

    mockGet.mockResolvedValue({ wrapped: { id: 'wrapped' } });
    await expect(getRawDevices('devices')).resolves.toEqual({ wrapped: { id: 'wrapped' } });

    resetRestClient();
    await expect(getRawDevices('devices')).rejects.toThrow('REST client not initialized');

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeErrorToStderr('device manager failed', new Error('boom'));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('device manager failed'));

    logDeviceTransportRuntimeError(logger, { event: 'device_manager_runtime_failed' }, new Error('runtime boom'));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_manager_runtime_failed',
      err: expect.any(Error),
    }));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('device_manager_runtime_failed'));

    logDeviceTransportRuntimeError(logger, { event: 'device_manager_string_failure' }, 'string boom');
    const stringFailureCall = logger.error.mock.calls.find(
      ([payload]) => (payload as { event?: string })?.event === 'device_manager_string_failure',
    )?.[0] as { err?: unknown } | undefined;
    expect(stringFailureCall?.err).toBeInstanceOf(Error);
    expect((stringFailureCall?.err as Error).message).toBe('string boom');
  });
  it('dedupes peak-power updates within the same rounded band', () => {
    const logger = createLogger();
    const state = {
      lastKnownPowerKw: { dev1: 1.231 },
      lastPeakPowerLogByDevice: new Map(),
    };

    updateLastKnownPower({ state, logger, deviceId: 'dev1', measuredKw: 1.232, deviceLabel: 'Device 1' });
    updateLastKnownPower({ state, logger, deviceId: 'dev1', measuredKw: 1.234, deviceLabel: 'Device 1' });
    updateLastKnownPower({ state, logger, deviceId: 'dev1', measuredKw: 1.29, deviceLabel: 'Device 1' });

    expect(logger.structuredLog.debug).toHaveBeenCalledTimes(2);
    expect(logger.structuredLog.debug).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event: 'power_estimate_peak_updated',
      peakKw: 1.23,
    }));
    expect(logger.structuredLog.debug).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event: 'power_estimate_peak_updated',
      peakKw: 1.29,
    }));
  });

  it('does not probe an empty capability id when no binary control capability is known', () => {
    const latestSnapshot: TargetDeviceSnapshot[] = [];
    const capabilityAccesses: string[] = [];
    const capabilitiesObj = new Proxy({}, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') capabilityAccesses.push(prop);
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = reconcileRealtimeDeviceUpdate({
      latestSnapshot,
      device: {
        id: 'dev-1',
        capabilitiesObj,
      } as never,
      parseDevice: () => ({
        id: 'dev-1',
        name: 'Device 1',
        binaryControl: { on: true },
        targets: [],
      } as never),
    });

    expect(result.shouldReconcilePlan).toBe(false);
    expect(capabilityAccesses).not.toContain('');
  });

  it('hasRestClient reflects current state', () => {
    resetRestClient();
    expect(hasRestClient()).toBe(false);
    setRestClient({ get: vi.fn(), put: vi.fn() });
    expect(hasRestClient()).toBe(true);
    resetRestClient();
    expect(hasRestClient()).toBe(false);
  });

  it('setRawCapabilityValue calls PUT with correct path and payload', async () => {
    const mockPut = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put: mockPut });

    await setRawCapabilityValue('dev-1', 'target_temperature', 22);

    expect(mockPut).toHaveBeenCalledWith(
      'manager/devices/device/dev-1/capability/target_temperature',
      { value: 22 },
    );
  });

  it('setRawCapabilityValue throws and logs on PUT failure', async () => {
    const mockPut = vi.fn().mockRejectedValue(new Error('network error'));
    setRestClient({ get: vi.fn(), put: mockPut });
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(setRawCapabilityValue('dev-1', 'onoff', true)).rejects.toThrow('network error');
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('setRawCapabilityValue PUT'),
    );
  });

  it('setRawCapabilityValue throws when REST client is not initialized', async () => {
    resetRestClient();
    await expect(setRawCapabilityValue('dev-1', 'onoff', true))
      .rejects.toThrow('REST client not initialized');
  });

  it('getRawDevice returns a single device by ID', async () => {
    const device = { id: 'dev-1', name: 'Heater' };
    const mockGet = vi.fn().mockResolvedValue(device);
    setRestClient({ get: mockGet, put: vi.fn() });

    const result = await getRawDevice('dev-1');
    expect(result).toEqual(device);
    expect(mockGet).toHaveBeenCalledWith('manager/devices/device/dev-1');
  });

  it('getRawDevice throws on invalid response', async () => {
    const mockGet = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: mockGet, put: vi.fn() });

    await expect(getRawDevice('dev-1')).rejects.toThrow('Invalid response for device dev-1');
  });

  it('getRawDevice throws when REST client is not initialized', async () => {
    resetRestClient();
    await expect(getRawDevice('dev-1'))
      .rejects.toThrow('REST client not initialized');
  });

  it('fetchDevicesByIds returns all devices on success', async () => {
    const devices = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const mockGet = vi.fn()
      .mockResolvedValueOnce(devices[0])
      .mockResolvedValueOnce(devices[1]);
    setRestClient({ get: mockGet, put: vi.fn() });
    const logger = createLogger();

    const result = await fetchDevicesByIds({
      deviceIds: ['a', 'b'],
      logger,
    });

    expect(result.fetchSource).toBe('targeted_by_id');
    expect(result.devices).toEqual(devices);
  });

  it('fetchDevicesByIds returns empty list for empty IDs', async () => {
    const logger = createLogger();
    const result = await fetchDevicesByIds({
      deviceIds: [],
      logger,
    });
    expect(result.devices).toEqual([]);
    expect(result.fetchSource).toBe('targeted_by_id');
  });

  it('fetchDevicesByIds falls back to full fetch on any failure', async () => {
    const allDevices = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    const mockGet = vi.fn()
      .mockResolvedValueOnce(allDevices[0])
      .mockRejectedValueOnce(new Error('not found'))
      // Full fetch fallback returns all devices as object
      .mockResolvedValueOnce(
        Object.fromEntries(allDevices.map((d) => [d.id, d])),
      );
    setRestClient({ get: mockGet, put: vi.fn() });
    const logger = createLogger();

    const result = await fetchDevicesByIds({
      deviceIds: ['a', 'b'],
      logger,
    });

    expect(result.fetchSource).toBe('raw_manager_devices');
    expect(result.devices).toHaveLength(3);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'targeted_fetch_fallback_to_full' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 1.4 / Regression 5.4: parser acceptance ≠ turn_off actuation eligibility
//
// A temperature-capable stepped device may be accepted by the parser even when
// it lacks an onoff capability. However, parser acceptance does NOT mean the
// device is eligible for turn_off actuation: getBinaryControlPlan returns null
// without onoff, so no binary command can be issued.
// ---------------------------------------------------------------------------

describe('parser-valid device without onoff is not eligible for turn_off actuation (Test 1.4 / Regression 5.4)', () => {
  it('resolveDeviceCapabilities accepts a temperature-capable device even without onoff', () => {
    // A stepped temperature water heater with target_temperature + measure_temperature
    // but no onoff capability — the parser accepts it because it has a target.
    const result = resolveDeviceCapabilities({
      deviceClassKey: 'thermostat',
      deviceId: 'dev-temp',
      deviceLabel: 'Hot Water Tank',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
    });

    // Parser accepts the device (returns non-null)
    expect(result).not.toBeNull();
    expect(result?.targetCaps).toContain('target_temperature');
  });

  it('getBinaryControlPlan returns null for a snapshot without onoff — turn_off cannot actuate', () => {
    // Same device as above, represented as a runtime snapshot without onoff.
    // getBinaryControlPlan is the actuation gate: null means no binary command is possible.
    const result = getBinaryControlPlan({
      id: 'dev-temp',
      name: 'Hot Water Tank',
      // No controlCapabilityId, no 'onoff' in capabilities
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
      canSetControl: true,
      binaryControl: { on: false },
    } as never);

    // Null = no binary control plan = turn_off cannot actuate even though parser accepted.
    expect(result).toBeNull();
  });

  it('a parser-valid temperature device without onoff is rejected at the actuation gate', () => {
    // This is the combined assertion: the two facts above form a deliberate invariant.
    // Parser acceptance and actuation eligibility are distinct properties.
    const parseResult = resolveDeviceCapabilities({
      deviceClassKey: 'thermostat',
      deviceId: 'dev-temp',
      deviceLabel: 'Hot Water Tank',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
    });
    const actuationGate = getBinaryControlPlan({
      id: 'dev-temp',
      name: 'Hot Water Tank',
      capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
      canSetControl: true,
      binaryControl: { on: false },
    } as never);

    // Parser accepts; actuation gate rejects.
    expect(parseResult).not.toBeNull();
    expect(actuationGate).toBeNull();
  });
});
