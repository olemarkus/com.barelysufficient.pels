import type { Logger, TargetDeviceSnapshot } from '../lib/utils/types';
import {
  buildOptimisticCapabilityUpdate,
  getCanSetControl,
  getControlCapabilityId,
  getCurrentOn,
  getEvChargingState,
  logEvCapabilityAccepted,
  logEvCapabilityRequest,
  logEvSnapshotChanges,
} from '../lib/core/deviceManagerControl';
import {
  buildTargets,
  getCapabilityValueByPrefix,
  getCurrentTemperature,
  resolveDeviceCapabilities,
} from '../lib/core/deviceManagerParse';
import {
  applyMeasurementUpdates,
  handlePowerUpdate,
  updateLastKnownPower,
} from '../lib/core/deviceManagerRuntime';
import { getRawDevices, writeErrorToStderr } from '../lib/core/deviceManagerHomeyApi';

const createLogger = () => ({
  log: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
}) as unknown as Logger & {
  log: jest.Mock;
  debug: jest.Mock;
  error: jest.Mock;
};

describe('device manager support helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves EV control capability and charging state helpers', () => {
    const capabilityObj = {
      evcharger_charging: { value: false, setable: true },
      evcharger_charging_state: { value: 'plugged_in_paused' },
      onoff: { value: true, setable: false },
      measure_temperature: { value: 21 },
      target_temperature: { value: 22, units: 'C' },
    };

    expect(getControlCapabilityId({ deviceClassKey: 'evcharger', capabilities: ['onoff', 'evcharger_charging'] })).toBe('evcharger_charging');
    expect(getControlCapabilityId({ deviceClassKey: 'socket', capabilities: ['onoff'] })).toBe('onoff');
    expect(getCurrentOn({ deviceClassKey: 'evcharger', capabilityObj, controlCapabilityId: 'evcharger_charging' })).toBe(false);
    expect(getCurrentOn({
      deviceClassKey: 'evcharger',
      capabilityObj: { evcharger_charging_state: { value: 'plugged_in_charging' } },
      controlCapabilityId: 'evcharger_charging',
    })).toBe(true);
    expect(getCurrentOn({
      deviceClassKey: 'socket',
      capabilityObj: { onoff: { value: true } },
      controlCapabilityId: 'onoff',
    })).toBe(true);
    expect(getCanSetControl('evcharger_charging', capabilityObj)).toBe(true);
    expect(getCanSetControl('onoff', capabilityObj)).toBe(false);
    expect(getEvChargingState(capabilityObj)).toBe('plugged_in_paused');
    expect(getCurrentTemperature(capabilityObj)).toBe(21);
    expect(buildTargets(['target_temperature'], capabilityObj)).toEqual([{ id: 'target_temperature', value: 22, unit: 'C' }]);
    expect(buildOptimisticCapabilityUpdate('evcharger_charging', true)).toBeNull();
    expect(buildOptimisticCapabilityUpdate('onoff', true)).toBeNull();
    expect(buildOptimisticCapabilityUpdate('target_temperature', 20)).toEqual({ target: 20 });
    expect(buildOptimisticCapabilityUpdate('measure_power', 300)).toBeNull();
  });

  it('logs EV command and snapshot changes', () => {
    const logger = createLogger();
    const previousSnapshot: TargetDeviceSnapshot[] = [
      { id: 'ev1', name: 'EV 1', deviceClass: 'evcharger', currentOn: false, evChargingState: 'plugged_in_paused', powerKw: 0, controlCapabilityId: 'evcharger_charging' },
    ];
    const nextSnapshot: TargetDeviceSnapshot[] = [
      { id: 'ev1', name: 'EV 1', deviceClass: 'evcharger', currentOn: true, evChargingState: 'plugged_in_charging', powerKw: 7.2, controlCapabilityId: 'evcharger_charging' },
      { id: 'ev2', name: 'EV 2', deviceClass: 'evcharger', currentOn: false, evChargingState: 'plugged_out', powerKw: 0, controlCapabilityId: 'evcharger_charging' },
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

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('EV command requested'));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('EV command accepted'));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('EV snapshot changed EV 1'));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('EV snapshot discovered EV 2'));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('EV snapshot removed EV 2'));
  });

  it('resolves device parse capabilities and power capability lookup', () => {
    const logDebug = jest.fn();
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'evcharger',
      deviceId: 'ev1',
      deviceLabel: 'EV 1',
      capabilities: ['measure_power'],
      logDebug,
    })).toBeNull();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('missing evcharger_charging'));
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'evcharger',
      deviceId: 'ev2',
      deviceLabel: 'EV 2',
      capabilities: ['evcharger_charging', 'measure_power'],
      logDebug,
    })).toBeNull();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('missing evcharger_charging_state'));
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'heater',
      deviceId: 'heater1',
      deviceLabel: 'Heater',
      capabilities: ['measure_temperature', 'target_temperature', 'measure_power'],
      logDebug,
    })).toEqual({ targetCaps: ['target_temperature'], hasPower: true });
    expect(resolveDeviceCapabilities({
      deviceClassKey: 'socket',
      deviceId: 'socket1',
      deviceLabel: 'Socket',
      capabilities: ['measure_power', 'onoff'],
      logDebug,
    })).toEqual({ targetCaps: [], hasPower: true });
    expect(getCapabilityValueByPrefix(
      ['measure_power.l1'],
      { 'measure_power.l1': { value: 400 } },
      'measure_power',
    )).toBe(400);
  });

  it('updates runtime device manager power state helpers', async () => {
    const logger = createLogger();
    const state = {
      lastKnownPowerKw: { dev1: 0.5 },
      lastMeasuredPowerKw: {} as Record<string, { kw: number; ts: number }>,
      lastMeterEnergyKwh: {} as Record<string, { kwh: number; ts: number }>,
    };
    const latestSnapshot: TargetDeviceSnapshot[] = [{ id: 'dev1', name: 'Device 1' }];

    updateLastKnownPower({ state, logger, deviceId: 'dev1', measuredKw: 1.2, deviceLabel: 'Device 1' });
    expect(state.lastKnownPowerKw.dev1).toBe(1.2);

    applyMeasurementUpdates({
      state,
      logger,
      deviceId: 'dev1',
      updates: {
        lastMeterEnergyKwh: { kwh: 10, ts: 1 },
        lastMeasuredPowerKw: { kw: 1.4, ts: 2 },
      },
      deviceLabel: 'Device 1',
    });
    expect(state.lastMeterEnergyKwh.dev1).toEqual({ kwh: 10, ts: 1 });
    expect(state.lastMeasuredPowerKw.dev1).toEqual({ kw: 1.4, ts: 2 });
    expect(state.lastKnownPowerKw.dev1).toBe(1.4);

    handlePowerUpdate({ state, logger, latestSnapshot, deviceId: 'dev1', label: 'Device 1', value: 1800 });
    expect(latestSnapshot[0].powerKw).toBe(1.8);
    handlePowerUpdate({ state, logger, latestSnapshot, deviceId: 'dev1', label: 'Device 1', value: null });
    expect(latestSnapshot[0].powerKw).toBe(1.8);

    const directHomey = {
      api: { get: jest.fn().mockResolvedValue([{ id: 'direct' }]) },
    };
    const wrappedHomey = {
      homey: {
        api: { get: jest.fn().mockResolvedValue({ wrapped: { id: 'wrapped' } }) },
      },
    };
    await expect(getRawDevices(directHomey as never, 'devices')).resolves.toEqual([{ id: 'direct' }]);
    await expect(getRawDevices(wrappedHomey as never, 'devices')).resolves.toEqual({ wrapped: { id: 'wrapped' } });
    await expect(getRawDevices({} as never, 'devices')).rejects.toThrow('Homey API client not available');

    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeErrorToStderr('device manager failed', new Error('boom'));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('device manager failed'));
  });
});
