import { createPlanEngineState } from '../lib/plan/planState';
import {
  formatEvSnapshot,
  getBinaryControlPlan,
  getEvRestoreBlockReason,
  setBinaryControl,
  syncPendingBinaryCommands,
} from '../lib/plan/planBinaryControl';

describe('plan binary control helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves binary control plans and EV restore blocks', () => {
    expect(getBinaryControlPlan()).toBeNull();
    expect(getBinaryControlPlan({
      id: 'dev1',
      name: 'Socket',
      controlCapabilityId: 'onoff',
      canSetControl: true,
    })).toEqual({ capabilityId: 'onoff', isEv: false, canSet: true });
    expect(getBinaryControlPlan({
      id: 'ev1',
      name: 'EV',
      capabilities: ['evcharger_charging'],
      canSetControl: false,
    })).toEqual({ capabilityId: 'evcharger_charging', isEv: true, canSet: false });

    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', expectedPowerSource: 'default' })).toBe('charger power unknown');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging' })).toBe('charger state unknown');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', evChargingState: 'plugged_out' })).toBe('charger is unplugged');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', evChargingState: 'plugged_in' })).toBeNull();
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', evChargingState: 'mystery' })).toBe("unknown charging state 'mystery'");
    expect(formatEvSnapshot()).toBe('snapshot=missing');
  });

  it('handles EV and standard binary control actions', async () => {
    const state = createPlanEngineState();
    const updateLocalSnapshot = jest.fn();
    const log = jest.fn();
    const logDebug = jest.fn();
    const error = jest.fn();
    const deviceManager = {
      setCapability: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue([
        { id: 'ev1', name: 'EV', currentOn: true, evChargingState: 'plugged_in_charging', controlCapabilityId: 'evcharger_charging' },
      ]),
    };

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: true,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
        evChargingState: 'plugged_in_paused',
      },
      logContext: 'capacity',
    })).resolves.toBe(true);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('ev1', 'evcharger_charging', true);
    expect(updateLocalSnapshot).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Capacity: resumed charging for EV');

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: true,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
      },
      logContext: 'capacity',
    })).resolves.toBe(false);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('already pending'));

    jest.spyOn(Date, 'now').mockReturnValue(state.pendingBinaryCommands.ev1.startedMs + 20_000);
    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
      },
      logContext: 'capacity',
      reason: 'shedding',
    })).resolves.toBe(true);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('socket1', 'onoff', false);
    expect(log).toHaveBeenCalledWith('Capacity: turned off Socket (shedding)');
  });

  it('does not resend the same standard binary command while it is pending', async () => {
    const state = createPlanEngineState();
    const logDebug = jest.fn();
    const deviceManager = {
      setCapability: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue([]),
    };

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: jest.fn(),
      log: jest.fn(),
      logDebug,
      error: jest.fn(),
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
      },
      logContext: 'capacity',
      reason: 'shedding',
    })).resolves.toBe(true);

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: jest.fn(),
      log: jest.fn(),
      logDebug,
      error: jest.fn(),
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
      },
      logContext: 'capacity',
      reason: 'shedding',
    })).resolves.toBe(false);

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('already pending'));
  });

  it('skips a standard binary command when the latest snapshot already matches the desired state', async () => {
    const state = createPlanEngineState();
    const log = jest.fn();
    const logDebug = jest.fn();
    const deviceManager = {
      setCapability: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue([{
        id: 'socket1',
        name: 'Socket',
        currentOn: true,
        controlCapabilityId: 'onoff',
        canSetControl: true,
      }]),
    };

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: jest.fn(),
      log,
      logDebug,
      error: jest.fn(),
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        currentOn: false,
        controlCapabilityId: 'onoff',
        canSetControl: true,
      },
      logContext: 'capacity',
      actuationMode: 'reconcile',
    })).resolves.toBe(false);

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: skip binary command for Socket, already on in current snapshot',
    );
  });

  it('clears pending standard binary commands once the live state confirms them', async () => {
    const state = createPlanEngineState();

    await expect(setBinaryControl({
      state,
      deviceManager: {
        setCapability: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: jest.fn(),
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
      },
      logContext: 'capacity',
      reason: 'shedding',
    })).resolves.toBe(true);

    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: false,
    });

    const logDebug = jest.fn();
    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'socket1',
        name: 'Socket',
        currentOn: false,
        hasBinaryControl: true,
        targets: [],
      }],
      source: 'device_update',
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: confirmed onoff for Socket at off via device_update',
    );
  });

  it('keeps a pending restore when telemetry still shows the device off', async () => {
    const state = createPlanEngineState();

    await expect(setBinaryControl({
      state,
      deviceManager: {
        setCapability: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: jest.fn(),
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        currentOn: false,
      },
      logContext: 'capacity',
    })).resolves.toBe(true);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'socket1',
        name: 'Socket',
        currentOn: false,
        hasBinaryControl: true,
        targets: [],
      }],
      source: 'rebuild',
      logDebug: jest.fn(),
    });

    expect(changed).toBe(false);
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: true,
    });
  });

  it('handles missing, blocked, and failing binary control requests', async () => {
    const state = createPlanEngineState();
    const updateLocalSnapshot = jest.fn();
    const log = jest.fn();
    const logDebug = jest.fn();
    const error = jest.fn();
    const failingManager = {
      setCapability: jest.fn().mockRejectedValue(new Error('kaput')),
      getSnapshot: jest.fn().mockReturnValue([]),
    };

    await expect(setBinaryControl({
      state,
      deviceManager: failingManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: { id: 'ev1', name: 'EV', deviceClass: 'evcharger' },
      logContext: 'capacity',
    })).resolves.toBe(false);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('no binary control plan'));

    await expect(setBinaryControl({
      state,
      deviceManager: failingManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: false,
      },
      logContext: 'capacity',
    })).resolves.toBe(false);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('capability not setable'));

    await expect(setBinaryControl({
      state,
      deviceManager: failingManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
      },
      logContext: 'capacity_control_off',
    })).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith('Failed to turn on Socket via DeviceManager', expect.any(Error));
  });

  it('clears stale pending binary commands even when the device is no longer present', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: false,
      startedMs: 1_000,
    };
    const logDebug = jest.fn();

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000 + 20_000);
    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [],
      source: 'rebuild',
      logDebug,
    });
    nowSpy.mockRestore();

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: cleared stale pending binary command for socket1: onoff=false after 20000ms',
    );
  });

  it('clears pending EV commands after a failed capability write', async () => {
    const state = createPlanEngineState();
    const error = jest.fn();

    await expect(setBinaryControl({
      state,
      deviceManager: {
        setCapability: jest.fn().mockRejectedValue(new Error('kaput')),
        getSnapshot: jest.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: jest.fn(),
      log: jest.fn(),
      logDebug: jest.fn(),
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: true,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
        evChargingState: 'plugged_in_paused',
        expectedPowerSource: 'load-setting',
      },
      logContext: 'capacity',
    })).resolves.toBe(false);

    expect(state.pendingBinaryCommands.ev1).toBeUndefined();
    expect(error).toHaveBeenCalledWith('Failed to resume EV charging for EV via DeviceManager', expect.any(Error));
  });
});
