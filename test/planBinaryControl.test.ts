import { createPlanEngineState } from '../lib/plan/planState';
import {
  formatEvSnapshot,
  getBinaryControlPlan,
  getEvRestoreBlockReason,
  setBinaryControl,
  syncPendingBinaryCommands,
} from '../lib/plan/planBinaryControl';
import { getPendingBinaryCommand } from '../lib/plan/planBinaryControlHelpers';

describe('plan binary control helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a slow Connected 300 restore pending for 60s before confirmative telemetry arrives', async () => {
    const state = createPlanEngineState();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await expect(setBinaryControl({
      state,
      deviceManager: {
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
      deviceId: 'connected-300',
      name: 'Connected 300',
      desired: true,
      snapshot: {
        id: 'connected-300',
        name: 'Connected 300',
        communicationModel: 'cloud',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        currentOn: false,
      },
      logContext: 'capacity',
    })).resolves.toBe(true);

    nowSpy.mockReturnValue(61_000);
    const waitingLog = vi.fn();
    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'connected-300',
        name: 'Connected 300',
        communicationModel: 'cloud',
        currentOn: false,
        hasBinaryControl: true,
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: waitingLog,
    });

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands['connected-300']).toMatchObject({
      desired: true,
      pendingMs: 75_000,
      lastObservedValue: false,
      lastObservedSource: 'snapshot_refresh',
    });
    expect(waitingLog).toHaveBeenCalledWith(
      'Capacity: waiting for onoff confirmation for Connected 300; observed off via snapshot_refresh, expected on',
    );

    nowSpy.mockReturnValue(77_000);
    const timeoutLog = vi.fn();
    const timedOut = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'connected-300',
        name: 'Connected 300',
        communicationModel: 'cloud',
        currentOn: false,
        hasBinaryControl: true,
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: timeoutLog,
    });
    nowSpy.mockRestore();

    expect(timedOut).toBe(true);
    expect(state.pendingBinaryCommands['connected-300']).toBeUndefined();
    expect(timeoutLog).toHaveBeenCalledWith(
      'Capacity: cleared stale pending binary command for Connected 300: onoff=true after 76000ms '
      + '(timeout 75000ms); last observed off via snapshot_refresh',
    );
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
    const updateLocalSnapshot = vi.fn();
    const log = vi.fn();
    const logDebug = vi.fn();
    const error = vi.fn();
    const structuredLog = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const debugStructured = vi.fn();
    const deviceManager = {
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([
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
      structuredLog,
      debugStructured,
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
      structuredLog,
      debugStructured,
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
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'binary_command_skipped',
      reasonCode: 'already_pending',
      deviceId: 'ev1',
      desired: true,
      capabilityId: 'evcharger_charging',
      logContext: 'capacity',
      actuationMode: 'plan',
    }));

    vi.spyOn(Date, 'now').mockReturnValue(state.pendingBinaryCommands.ev1.startedMs + 20_000);
    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      structuredLog,
      debugStructured,
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

  it('emits binary_command_failed when the device manager write fails', async () => {
    const state = createPlanEngineState();
    const failure = new Error('device unavailable');
    const structuredLog = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const deviceManager = {
      setCapability: vi.fn().mockRejectedValue(failure),
      getSnapshot: vi.fn().mockReturnValue([]),
    };

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
      structuredLog,
      debugStructured: vi.fn(),
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
    })).resolves.toBe(false);

    expect(structuredLog.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'binary_command_failed',
      reasonCode: 'device_manager_write_failed',
      deviceId: 'socket1',
      deviceName: 'Socket',
      capabilityId: 'onoff',
      desired: false,
      logContext: 'capacity',
      actuationMode: 'plan',
    }));
  });

  it('does not resend the same standard binary command while it is pending', async () => {
    const state = createPlanEngineState();
    const logDebug = vi.fn();
    const deviceManager = {
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([]),
    };

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug,
      error: vi.fn(),
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
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug,
      error: vi.fn(),
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
    const log = vi.fn();
    const logDebug = vi.fn();
    const deviceManager = {
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([{
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
      updateLocalSnapshot: vi.fn(),
      log,
      logDebug,
      error: vi.fn(),
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
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
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

    const logDebug = vi.fn();
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
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
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

    const logDebug = vi.fn();
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
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: true,
      lastObservedValue: false,
      lastObservedSource: 'rebuild',
    });
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: waiting for onoff confirmation for Socket; observed off via rebuild, expected on',
    );
  });

  it('logs unexpected conflicting telemetry while a binary command is still pending', async () => {
    const state = createPlanEngineState();

    await expect(setBinaryControl({
      state,
      deviceManager: {
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
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

    const logDebug = vi.fn();
    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'socket1',
        name: 'Socket',
        currentOn: false,
        hasBinaryControl: true,
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: true,
      lastObservedValue: false,
      lastObservedSource: 'snapshot_refresh',
    });
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: waiting for onoff confirmation for Socket; observed off via snapshot_refresh, expected on',
    );
  });

  it('confirms pending EV commands from charging state, not only currentOn', async () => {
    const state = createPlanEngineState();

    await expect(setBinaryControl({
      state,
      deviceManager: {
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
        currentOn: true,
        evChargingState: 'plugged_in_charging',
      },
      logContext: 'capacity',
    })).resolves.toBe(true);

    const logDebug = vi.fn();
    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: true,
        evChargingState: 'plugged_in_paused',
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        targets: [],
      }],
      source: 'device_update',
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.ev1).toBeUndefined();
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: confirmed evcharger_charging for EV at paused via device_update',
    );
  });

  it('handles missing, blocked, and failing binary control requests', async () => {
    const state = createPlanEngineState();
    const updateLocalSnapshot = vi.fn();
    const log = vi.fn();
    const logDebug = vi.fn();
    const error = vi.fn();
    const failingManager = {
      setCapability: vi.fn().mockRejectedValue(new Error('kaput')),
      getSnapshot: vi.fn().mockReturnValue([]),
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
    const logDebug = vi.fn();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000 + 20_000);
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
      'Capacity: cleared stale pending binary command for device socket1: onoff=false after 20000ms (timeout 15000ms)',
    );
  });

  it('logs the clearing stale message when getPendingBinaryCommand removes an expired entry', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: false,
      startedMs: 1_000,
    };
    const logDebug = vi.fn();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000 + 20_000);
    const pending = getPendingBinaryCommand(state, 'socket1', logDebug);
    nowSpy.mockRestore();

    expect(pending).toBeUndefined();
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: clearing stale pending binary command for socket1: onoff=false after 20000ms (timeout 15000ms)',
    );
  });

  it('clears pending EV commands after a failed capability write', async () => {
    const state = createPlanEngineState();
    const error = vi.fn();

    await expect(setBinaryControl({
      state,
      deviceManager: {
        setCapability: vi.fn().mockRejectedValue(new Error('kaput')),
        getSnapshot: vi.fn().mockReturnValue([]),
      } as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug: vi.fn(),
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

// ---------------------------------------------------------------------------
// Group 1.3 & 1.4: turn_off eligibility requires onoff capability
// These tests prove that binary control (and therefore turn_off actuation) is
// unavailable when the device snapshot lacks onoff or evcharger_charging.
// ---------------------------------------------------------------------------

describe('binary control plan requires onoff capability (Group 1.3)', () => {
  // Test 1.3: A device without any binary control capability cannot get a binary
  // control plan. getBinaryControlPlan is the runtime gate for turn_off actuation.
  it('getBinaryControlPlan returns null for a snapshot with no onoff or evcharger_charging capability', () => {
    expect(getBinaryControlPlan({
      id: 'dev-1',
      name: 'No-Onoff Device',
      capabilities: ['measure_power', 'target_temperature'],
      // No 'onoff', no 'evcharger_charging', no controlCapabilityId
    } as never)).toBeNull();
  });

  it('getBinaryControlPlan returns null for an undefined snapshot', () => {
    expect(getBinaryControlPlan(undefined)).toBeNull();
  });

  // Test 1.3 (actuation path): setBinaryControl returns false and skips the command
  // when the snapshot has no onoff capability, proving turn_off cannot actuate.
  it('setBinaryControl returns false and skips binary command when snapshot has no onoff', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn();

    const result = await setBinaryControl({
      state,
      deviceManager: {
        setCapability,
        getSnapshot: vi.fn().mockReturnValue([]),
      } as never,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
      deviceId: 'dev-1',
      name: 'No-Onoff Device',
      desired: false,
      snapshot: {
        id: 'dev-1',
        name: 'No-Onoff Device',
        // No controlCapabilityId, no onoff in capabilities
        canSetControl: true,
        currentOn: true,
      } as never,
      logContext: 'capacity',
    });

    expect(result).toBe(false);
    expect(setCapability).not.toHaveBeenCalled();
  });
});
