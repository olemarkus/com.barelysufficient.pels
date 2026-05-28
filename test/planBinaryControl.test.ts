import { createPlanEngineState } from '../lib/plan/planState';
import {
  formatEvSnapshot,
  getBinaryControlPlan,
  getEvRestoreBlockReason,
} from '../lib/plan/planBinaryControl';
import { syncPendingBinaryCommands } from '../lib/observer/pendingBinaryCommands';
import { getPendingBinaryCommand } from '../lib/plan/planBinaryControlHelpers';
import { captureLogger, type LoggerCapture } from './utils/loggerCapture';
import { withGetSnapshotByDeviceId } from './utils/deviceObservationMock';
import { runBinaryControlCycle as setBinaryControl } from './utils/binaryControlTestHelpers';

let logCapture: LoggerCapture;

beforeEach(() => {
  logCapture = captureLogger();
});

afterEach(() => {
  logCapture.restore();
});

const binaryObservation = (
  capabilityId: 'onoff' | 'evcharger_charging',
  observedValue: boolean,
  observedAtMs: number,
  observedCapabilityIds: string[] = [capabilityId],
) => ({
  valid: true as const,
  capabilityId,
  observedValue,
  observedCapabilityIds,
  observedAtMs,
});

describe('plan binary control helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a slow Connected 300 restore pending for 60s before confirmative telemetry arrives', async () => {
    const state = createPlanEngineState();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await expect(setBinaryControl({
      state,
      deviceManager: withGetSnapshotByDeviceId({
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      }) as never,
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
    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'connected-300',
        name: 'Connected 300',
        communicationModel: 'cloud',
        currentOn: false,
        hasBinaryControl: true,
        binaryControlObservation: binaryObservation('onoff', false, 61_000),
        targets: [],
      }],
      source: 'snapshot_refresh',
    });

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands['connected-300']).toMatchObject({
      desired: true,
      pendingMs: 75_000,
      lastObservedValue: false,
      lastObservedSource: 'snapshot_refresh',
    });
    expect(logCapture.findEvent('pending_binary_command_waiting')).toMatchObject({
      deviceName: 'Connected 300',
      capabilityId: 'onoff',
      observedValue: 'off',
      expected: 'on',
      source: 'snapshot_refresh',
    });

    nowSpy.mockReturnValue(77_000);
    const timedOut = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'connected-300',
        name: 'Connected 300',
        communicationModel: 'cloud',
        currentOn: false,
        hasBinaryControl: true,
        binaryControlObservation: binaryObservation('onoff', false, 61_000),
        targets: [],
      }],
      source: 'snapshot_refresh',
    });
    nowSpy.mockRestore();

    expect(timedOut).toBe(true);
    expect(state.pendingBinaryCommands['connected-300']).toBeUndefined();
    expect(logCapture.findEvent('pending_binary_command_timed_out')).toMatchObject({
      deviceName: 'Connected 300',
      capabilityId: 'onoff',
      desired: true,
      ageMs: 76000,
      timeoutMs: 75000,
      lastObservedValue: false,
      lastObservedSource: 'snapshot_refresh',
    });
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

    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', expectedPowerSource: 'default' })).toBe('charger state unknown');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging' })).toBe('charger state unknown');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', evChargingState: 'plugged_out' })).toBe('charger is unplugged');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', evChargingState: 'plugged_in' })).toBe('charger is not resumable');
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
    const deviceManager = withGetSnapshotByDeviceId({
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([
        { id: 'ev1', name: 'EV', currentOn: true, evChargingState: 'plugged_in_charging', controlCapabilityId: 'evcharger_charging' },
      ]),
    });

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
    expect(logCapture.findEvent('binary_command_succeeded')).toMatchObject({ deviceName: 'EV', capabilityId: 'evcharger_charging', desired: true });

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
    expect(logCapture.findEvent('binary_command_skipped')).toMatchObject({
      reasonCode: 'already_pending',
      deviceId: 'ev1',
      desired: true,
      capabilityId: 'evcharger_charging',
      logContext: 'capacity',
      actuationMode: 'plan',
    });

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
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_succeeded', deviceName: 'Socket', capabilityId: 'onoff', desired: false,
    }));
  });

  it('requests flow-backed binary control through a trigger instead of writing the native capability', async () => {
    const state = createPlanEngineState();
    const triggerFlowBackedBinaryControlRequest = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const structuredLog = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const deviceManager = withGetSnapshotByDeviceId({
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([]),
    });

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      triggerFlowBackedBinaryControlRequest,
      log,
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
        flowBacked: true,
        flowBackedCapabilityIds: ['onoff'],
        canSetControl: true,
        currentOn: true,
      },
      logContext: 'capacity',
      reason: 'shedding',
    })).resolves.toBe(true);

    expect(triggerFlowBackedBinaryControlRequest).toHaveBeenCalledWith({
      deviceId: 'socket1',
      name: 'Socket',
      capabilityId: 'onoff',
      desired: false,
      logContext: 'capacity',
      actuationMode: 'plan',
    });
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(logCapture.findEvent('flow_backed_binary_command_requested')).toMatchObject({
      deviceId: 'socket1',
      deviceName: 'Socket',
      capabilityId: 'onoff',
      desired: false,
      logContext: 'capacity',
      actuationMode: 'plan',
    });
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: false,
    });
  });

  it('emits binary_command_failed when the device manager write fails', async () => {
    const state = createPlanEngineState();
    const failure = new Error('device unavailable');
    const structuredLog = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const deviceManager = withGetSnapshotByDeviceId({
      setCapability: vi.fn().mockRejectedValue(failure),
      getSnapshot: vi.fn().mockReturnValue([]),
    });

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

    expect(logCapture.findEvent('binary_command_failed')).toMatchObject({
      reasonCode: 'device_manager_write_failed',
      deviceId: 'socket1',
      deviceName: 'Socket',
      capabilityId: 'onoff',
      desired: false,
      logContext: 'capacity',
      actuationMode: 'plan',
    });
  });

  it('does not resend the same standard binary command while it is pending', async () => {
    const state = createPlanEngineState();
    const logDebug = vi.fn();
    const deviceManager = withGetSnapshotByDeviceId({
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([]),
    });

    const debugStructured = vi.fn();
    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug,
      error: vi.fn(),
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

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug,
      error: vi.fn(),
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
    })).resolves.toBe(false);

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(logCapture.findEvent('binary_command_skipped')).toMatchObject({
      reasonCode: 'already_pending',
    });
  });

  it('promotes a pending release entry to capacity when a later capacity shed targets the same device', async () => {
    // Codex review of #1249 round 3: when a flow-backed binary device has an
    // in-flight `logContext: 'release'` pending off-write (smart-task
    // lifecycle release) and a later cycle decides the same device must be
    // off for capacity, the pending entry was satisfying the new request
    // without upgrading. `handleConfirmedBinaryCommand` would then route the
    // confirmation through the diagnostic-only recorder, leaving the
    // capacity shed without its lastInstabilityMs/lastDeviceShedMs cooldown
    // markers. The promotion path mutates the pending's logContext to
    // 'capacity' on the second cycle.
    const state = createPlanEngineState();
    const logDebug = vi.fn();
    const debugStructured = vi.fn();
    const deviceManager = withGetSnapshotByDeviceId({
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([]),
    });
    const snapshot = {
      id: 'socket1',
      name: 'Socket',
      controlCapabilityId: 'onoff' as const,
      canSetControl: true,
    };
    // Cycle 1: release-initiated off-write.
    await setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug,
      error: vi.fn(),
      debugStructured,
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot,
      logContext: 'release',
      reason: 'release',
    });
    expect(state.pendingBinaryCommands.socket1?.logContext).toBe('release');

    // Cycle 2: capacity shed targets the same device.
    await setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: vi.fn(),
      log: vi.fn(),
      logDebug,
      error: vi.fn(),
      debugStructured,
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot,
      logContext: 'capacity',
      reason: 'shedding',
    });

    // No duplicate write; the pending entry's logContext is promoted so the
    // confirmation will route through the cap-shed recorder.
    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(state.pendingBinaryCommands.socket1?.logContext).toBe('capacity');
    // Direct (non-flow-backed) device: handleConfirmedBinaryCommand
    // early-returns for !flowBackedControl, so the promoted logContext is
    // never read at confirmation. Set the cap-shed cooldown markers here
    // so the capacity shed gets its instability/cooldown clock advance
    // (codex round-4 finding on PR #1249).
    expect(state.lastInstabilityMs).toBeGreaterThan(0);
    expect(state.lastDeviceShedMs.socket1).toBeGreaterThan(0);
  });

  it('promotes a flow-backed pending release without setting instability markers at promotion time', async () => {
    // Counter-case for the direct-device branch above. For flow-backed
    // devices, handleConfirmedBinaryCommand reads the promoted logContext
    // on confirmation and dispatches via the cap-shed recorder, which sets
    // the markers there. Setting them at promotion time too would be
    // redundant — verify the synchronous marker-set is gated on
    // !pending.flowBackedControl.
    const state = createPlanEngineState();
    const triggerFlowBackedBinaryControlRequest = vi.fn().mockResolvedValue(undefined);
    const structuredLog = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const deviceManager = withGetSnapshotByDeviceId({
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([]),
    });
    const snapshot = {
      id: 'socket1',
      name: 'Socket',
      controlCapabilityId: 'onoff' as const,
      flowBacked: true,
      flowBackedCapabilityIds: ['onoff'],
      canSetControl: true,
      currentOn: true,
    };
    await setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      triggerFlowBackedBinaryControlRequest,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
      structuredLog,
      debugStructured: vi.fn(),
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot,
      logContext: 'release',
      reason: 'release',
    });
    await setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      triggerFlowBackedBinaryControlRequest,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
      structuredLog,
      debugStructured: vi.fn(),
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot,
      logContext: 'capacity',
      reason: 'shedding',
    });
    expect(state.pendingBinaryCommands.socket1?.logContext).toBe('capacity');
    expect(state.pendingBinaryCommands.socket1?.flowBackedControl).toBe(true);
    // Flow-backed path: markers stay unset until confirmation. The
    // promoted logContext routes the eventual recordShedActuation
    // through the cap-shed branch (isRelease=false).
    expect(state.lastInstabilityMs ?? 0).toBe(0);
    expect(state.lastDeviceShedMs.socket1 ?? 0).toBe(0);
  });

  it('skips a standard binary command when the latest snapshot already matches the desired state', async () => {
    const state = createPlanEngineState();
    const log = vi.fn();
    const logDebug = vi.fn();
    const debugStructured = vi.fn();
    const deviceManager = withGetSnapshotByDeviceId({
      setCapability: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockReturnValue([{
        id: 'socket1',
        name: 'Socket',
        currentOn: true,
        controlCapabilityId: 'onoff',
        canSetControl: true,
      }]),
    });

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot: vi.fn(),
      log,
      logDebug,
      error: vi.fn(),
      debugStructured,
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
    expect(logCapture.findEvent('binary_command_succeeded')).toBeUndefined();
    expect(logCapture.findEvent('binary_command_skipped')).toMatchObject({
      reasonCode: 'already_matched',
    });
  });

  it('clears pending standard binary commands once the live state confirms them', async () => {
    const state = createPlanEngineState();

    await expect(setBinaryControl({
      state,
      deviceManager: withGetSnapshotByDeviceId({
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      }) as never,
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
        binaryControlObservation: binaryObservation(
          'onoff',
          false,
          state.pendingBinaryCommands.socket1.startedMs + 1,
        ),
        targets: [],
      }],
      source: 'device_update',
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logCapture.findEvent('pending_binary_command_confirmed')).toMatchObject({
      deviceName: 'Socket',
      capabilityId: 'onoff',
      observedValue: 'off',
      source: 'device_update',
    });
  });

  it('keeps a pending restore when telemetry still shows the device off', async () => {
    const state = createPlanEngineState();

    await expect(setBinaryControl({
      state,
      deviceManager: withGetSnapshotByDeviceId({
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      }) as never,
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
        binaryControlObservation: binaryObservation(
          'onoff',
          false,
          state.pendingBinaryCommands.socket1.startedMs + 1,
        ),
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
    expect(logCapture.findEvent('pending_binary_command_waiting')).toMatchObject({
      deviceName: 'Socket',
      capabilityId: 'onoff',
      observedValue: 'off',
      expected: 'on',
      source: 'rebuild',
    });
  });

  it('does not settle a binary command from stale snapshot evidence', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'socket1',
        name: 'Socket',
        currentOn: true,
        hasBinaryControl: true,
        binaryControlObservation: binaryObservation('onoff', true, 999),
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: vi.fn(),
    });
    nowSpy.mockRestore();

    expect(changed).toBe(false);
    expect(state.pendingBinaryCommands.socket1).toBeDefined();
  });

  it('settles a binary command from fresh snapshot evidence', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'socket1',
        name: 'Socket',
        currentOn: true,
        hasBinaryControl: true,
        binaryControlObservation: binaryObservation('onoff', true, 1_001),
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: vi.fn(),
    });
    nowSpy.mockRestore();

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
  });

  it('does not settle a newly started command from same-millisecond old evidence', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'socket1',
        name: 'Socket',
        currentOn: true,
        hasBinaryControl: true,
        binaryControlObservation: binaryObservation('onoff', true, 1_000),
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: vi.fn(),
    });
    nowSpy.mockRestore();

    expect(changed).toBe(false);
    expect(state.pendingBinaryCommands.socket1).toBeDefined();
  });

  it('does not settle from non-finite evidence timestamps', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'socket1',
        name: 'Socket',
        currentOn: true,
        hasBinaryControl: true,
        binaryControlObservation: binaryObservation('onoff', true, Number.NaN),
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: vi.fn(),
    });
    nowSpy.mockRestore();

    expect(changed).toBe(false);
    expect(state.pendingBinaryCommands.socket1).toBeDefined();
  });

  it('logs unexpected conflicting telemetry while a binary command is still pending', async () => {
    const state = createPlanEngineState();

    await expect(setBinaryControl({
      state,
      deviceManager: withGetSnapshotByDeviceId({
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      }) as never,
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
        binaryControlObservation: binaryObservation(
          'onoff',
          false,
          state.pendingBinaryCommands.socket1.startedMs + 1,
        ),
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
    expect(logCapture.findEvent('pending_binary_command_waiting')).toMatchObject({
      deviceName: 'Socket',
      capabilityId: 'onoff',
      observedValue: 'off',
      expected: 'on',
      source: 'snapshot_refresh',
    });
  });

  it('confirms pending EV commands from charging state, not only currentOn', async () => {
    const state = createPlanEngineState();

    await expect(setBinaryControl({
      state,
      deviceManager: withGetSnapshotByDeviceId({
        setCapability: vi.fn().mockResolvedValue(undefined),
        getSnapshot: vi.fn().mockReturnValue([]),
      }) as never,
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
        binaryControlObservation: binaryObservation(
          'evcharger_charging',
          false,
          state.pendingBinaryCommands.ev1.startedMs + 1,
          ['evcharger_charging_state'],
        ),
        targets: [],
      }],
      source: 'device_update',
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.ev1).toBeUndefined();
    expect(logCapture.findEvent('pending_binary_command_confirmed')).toMatchObject({
      deviceName: 'EV',
      capabilityId: 'evcharger_charging',
      observedValue: 'paused',
      source: 'device_update',
    });
  });

  it('does not settle a pending EV pause from raw false while charging state is still charging', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.ev1 = {
      capabilityId: 'evcharger_charging',
      desired: false,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: true,
        evChargingState: 'plugged_in_charging',
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation('evcharger_charging', false, 1_001),
        targets: [],
      }],
      source: 'device_update',
      logDebug: vi.fn(),
    });
    nowSpy.mockRestore();

    expect(changed).toBe(false);
    expect(state.pendingBinaryCommands.ev1).toBeDefined();
  });

  it('does not settle a pending EV pause from raw evidence while charging state is present', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.ev1 = {
      capabilityId: 'evcharger_charging',
      desired: false,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: true,
        evChargingState: 'plugged_in_paused',
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation('evcharger_charging', false, 1_001),
        targets: [],
      }],
      source: 'device_update',
      logDebug: vi.fn(),
    });
    nowSpy.mockRestore();

    expect(changed).toBe(false);
    expect(state.pendingBinaryCommands.ev1).toBeDefined();
  });

  it('does not settle EV pending commands from raw evidence even when the current EV state agrees', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.ev1 = {
      capabilityId: 'evcharger_charging',
      desired: false,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: true,
        evChargingState: 'plugged_in_paused',
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation('evcharger_charging', false, 1_001),
        targets: [],
      }],
      source: 'device_update',
      logDebug: vi.fn(),
    });
    nowSpy.mockRestore();

    expect(changed).toBe(false);
    expect(state.pendingBinaryCommands.ev1).toBeDefined();
  });

  it('settles pending EV resume from charging state', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.ev1 = {
      capabilityId: 'evcharger_charging',
      desired: true,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const logDebug = vi.fn();
    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: true,
        evChargingState: 'plugged_in_charging',
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation(
          'evcharger_charging',
          true,
          1_001,
          ['evcharger_charging_state'],
        ),
        targets: [],
      }],
      source: 'device_update',
      logDebug,
    });
    nowSpy.mockRestore();

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.ev1).toBeUndefined();
    expect(logCapture.findEvent('pending_binary_command_confirmed')).toMatchObject({
      deviceName: 'EV',
      capabilityId: 'evcharger_charging',
      observedValue: 'charging',
      source: 'device_update',
    });
  });

  it('does not settle EV resume by recomputing old state evidence from a newer charging state', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.ev1 = {
      capabilityId: 'evcharger_charging',
      desired: true,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: true,
        evChargingState: 'plugged_in_charging',
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation(
          'evcharger_charging',
          false,
          1_001,
          ['evcharger_charging_state'],
        ),
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: vi.fn(),
    });
    nowSpy.mockRestore();

    expect(changed).toBe(true);
    expect(state.pendingBinaryCommands.ev1).toBeDefined();
    expect(state.pendingBinaryCommands.ev1.lastObservedValue).toBe(false);
  });

  it('settles raw EV boolean-only evidence only when state is absent and fresh', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.ev1 = {
      capabilityId: 'evcharger_charging',
      desired: false,
      startedMs: 1_000,
    };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);

    const staleChanged = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: false,
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation('evcharger_charging', false, 999),
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: vi.fn(),
    });

    expect(staleChanged).toBe(false);
    expect(state.pendingBinaryCommands.ev1).toBeDefined();

    const invalidStateChanged = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: false,
        evChargingState: 'mystery',
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation('evcharger_charging', false, 1_001),
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: vi.fn(),
    });

    expect(invalidStateChanged).toBe(false);
    expect(state.pendingBinaryCommands.ev1).toBeDefined();

    const freshChanged = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: false,
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation('evcharger_charging', false, 1_001),
        targets: [],
      }],
      source: 'snapshot_refresh',
      logDebug: vi.fn(),
    });

    expect(freshChanged).toBe(true);
    expect(state.pendingBinaryCommands.ev1).toBeUndefined();
    nowSpy.mockRestore();
  });

  it('runs confirmation callbacks before clearing pending flow-backed binary commands', () => {
    const state = createPlanEngineState();
    const startedMs = Date.now();
    state.pendingBinaryCommands.ev1 = {
      capabilityId: 'evcharger_charging',
      desired: false,
      startedMs,
      flowBackedControl: true,
      logContext: 'capacity',
      actuationMode: 'plan',
    };
    const logDebug = vi.fn();
    const onConfirmed = vi.fn();

    const changed = syncPendingBinaryCommands({
      state,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        currentOn: true,
        evChargingState: 'plugged_in_paused',
        hasBinaryControl: true,
        controlCapabilityId: 'evcharger_charging',
        binaryControlObservation: binaryObservation(
          'evcharger_charging',
          false,
          startedMs + 1,
          ['evcharger_charging_state'],
        ),
        targets: [],
      }],
      source: 'device_update',
      logDebug,
      onConfirmed,
    });

    expect(changed).toBe(true);
    expect(onConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'ev1',
      source: 'device_update',
      pending: expect.objectContaining({
        capabilityId: 'evcharger_charging',
        desired: false,
        flowBackedControl: true,
      }),
      liveDevice: expect.objectContaining({
        id: 'ev1',
        name: 'EV',
      }),
      confirmedAtMs: expect.any(Number),
    }));
    expect(state.pendingBinaryCommands.ev1).toBeUndefined();
  });

  it('handles missing, blocked, and failing binary control requests', async () => {
    const state = createPlanEngineState();
    const updateLocalSnapshot = vi.fn();
    const log = vi.fn();
    const logDebug = vi.fn();
    const error = vi.fn();
    const debugStructured = vi.fn();
    const failingManager = withGetSnapshotByDeviceId({
      setCapability: vi.fn().mockRejectedValue(new Error('kaput')),
      getSnapshot: vi.fn().mockReturnValue([]),
    });

    await expect(setBinaryControl({
      state,
      deviceManager: failingManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      debugStructured,
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: { id: 'ev1', name: 'EV', deviceClass: 'evcharger' },
      logContext: 'capacity',
    })).resolves.toBe(false);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_skipped',
      reasonCode: expect.stringMatching(/missing_(onoff_capability|control_targets)/),
    }));

    await expect(setBinaryControl({
      state,
      deviceManager: failingManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      debugStructured,
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
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_skipped',
      reasonCode: 'capability_not_setable',
    }));

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
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_failed',
      msg: 'Failed to turn on Socket via DeviceTransport',
    }));
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
    expect(logCapture.findEvent('pending_binary_command_timed_out')).toMatchObject({
      deviceId: 'socket1',
      capabilityId: 'onoff',
      desired: false,
      ageMs: 20000,
      timeoutMs: 15000,
    });
  });

  it('removes an expired entry when getPendingBinaryCommand observes a stale pending', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: false,
      startedMs: 1_000,
    };

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000 + 20_000);
    const pending = getPendingBinaryCommand(state, 'socket1');
    nowSpy.mockRestore();

    expect(pending).toBeUndefined();
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
  });

  it('clears pending EV commands after a failed capability write', async () => {
    const state = createPlanEngineState();
    const error = vi.fn();

    await expect(setBinaryControl({
      state,
      deviceManager: withGetSnapshotByDeviceId({
        setCapability: vi.fn().mockRejectedValue(new Error('kaput')),
        getSnapshot: vi.fn().mockReturnValue([]),
      }) as never,
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
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_failed',
      msg: 'Failed to resume EV charging for EV via DeviceTransport',
    }));
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
      deviceManager: withGetSnapshotByDeviceId({
        setCapability,
        getSnapshot: vi.fn().mockReturnValue([]),
      }) as never,
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
