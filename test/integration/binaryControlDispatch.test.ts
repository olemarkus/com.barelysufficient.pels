import { createPlanEngineState } from '../../lib/plan/planState';
import type { BinaryControlDecisionSnapshot } from '../../lib/plan/planBinaryControlHelpers';
import { decideBinaryControl } from '../../lib/plan/planBinaryControl';
import type { EvObservedProbe } from '../../packages/contracts/src/types';
import {
  type BinaryControlTransport,
  decideAndDispatchBinaryControl,
  dispatchBinaryControlDecision,
} from '../../lib/executor/binaryControlDispatch';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';
import {
  type BinaryCommandLifecycleListener,
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

let logCapture: LoggerCapture;

beforeEach(() => {
  logCapture = captureLogger();
});

afterEach(() => {
  logCapture.restore();
});

describe('recent successful OFF provenance', () => {
  it('does not let an older late success replace a newer issue timestamp', () => {
    const store = createPendingBinaryCommandStore({});
    store.recordConfirmedBinaryCommand({
      deviceId: 'socket1',
      capabilityId: 'onoff',
      desired: false,
      confirmedAtMs: 2_000,
    });
    store.recordConfirmedBinaryCommand({
      deviceId: 'socket1',
      capabilityId: 'onoff',
      desired: false,
      confirmedAtMs: 1_000,
    });

    expect(store.hasRecentConfirmedOff('socket1', 'onoff', 301_999)).toBe(true);
  });

  it('does not let an older ON confirmation erase a newer confirmed OFF', () => {
    const store = createPendingBinaryCommandStore({});
    store.recordConfirmedBinaryCommand({
      deviceId: 'socket1',
      capabilityId: 'onoff',
      desired: false,
      confirmedAtMs: 2_000,
    });
    store.recordConfirmedBinaryCommand({
      deviceId: 'socket1',
      capabilityId: 'onoff',
      desired: true,
      confirmedAtMs: 1_000,
    });

    expect(store.hasRecentConfirmedOff('socket1', 'onoff', 3_000)).toBe(true);
  });
});

const buildObservation = (snapshots: { id: string; currentOn?: boolean }[] = []) =>
  withGetSnapshotByDeviceId({
    getSnapshot: vi.fn().mockReturnValue(snapshots),
  });

/**
 * Fixture builder for the decomposed `BinaryControlDecisionSnapshot` the
 * decision/dispatch entry points read. Defaults the required `targets` array and
 * widens with `EvObservedProbe` so EV fixtures can carry the observer-owned
 * `evChargingState` (regrouped onto the snapshot, off the base type).
 */
const snapshot = (
  overrides: Partial<BinaryControlDecisionSnapshot> & EvObservedProbe & { id: string; name: string },
): BinaryControlDecisionSnapshot & EvObservedProbe => ({
  targets: [],
  ...overrides,
});

/**
 * Build a `BinaryControlTransport` whose write seam is a real actuator over the
 * provided `setCapability` / `triggerFlowBackedBinaryControl` mocks. Binary
 * dispatch routes through `actuator.apply`, so the underlying-mock assertions
 * (native → setCapability, flow → trigger-not-setCapability) are identical to
 * the pre-actuator transport's direct-method assertions.
 */
const buildTransport = (
  state: ReturnType<typeof createPlanEngineState>,
  ports: {
    setCapability: ActuatorTransport['setCapability'];
    triggerFlowBackedBinaryControl?: ActuatorTransport['triggerFlowBackedBinaryControl'];
  },
  lifecycle?: BinaryCommandLifecycleListener,
): BinaryControlTransport => {
  const rejectMissingTrigger = () => Promise.reject(new Error('Flow-backed control trigger is unavailable'));
  const actuator = createDeviceActuator({
    setCapability: ports.setCapability,
    applyDeviceTargets: () => Promise.resolve(),
    triggerFlowBackedBinaryControl: ports.triggerFlowBackedBinaryControl ?? rejectMissingTrigger,
  });
  return {
    observation: buildObservation(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands, lifecycle),
    actuator,
  };
};

describe('decideBinaryControl (plan-side decision producer)', () => {
  it('returns a populated decision without recording pending state (observer owns the writes)', () => {
    const state = createPlanEngineState();
    const observation = buildObservation();

    const decision = decideBinaryControl({
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      deviceObservation: observation,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        binaryControl: { on: false },
      }),
      logContext: 'capacity',
    });

    expect(decision).toEqual({
      deviceId: 'socket1',
      name: 'Socket',
      capabilityId: 'onoff',
      desired: true,
      flowBackedControl: false,
      logContext: 'capacity',
      restoreSource: undefined,
      reason: undefined,
    });
    // Plan no longer touches pending state — dispatcher records it.
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
  });

  it('returns null and leaves pending state untouched when the snapshot already matches', () => {
    const state = createPlanEngineState();
    const observation = buildObservation();

    const decision = decideBinaryControl({
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      deviceObservation: observation,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        binaryControl: { on: true },
      }),
      logContext: 'capacity',
    });

    expect(decision).toBeNull();
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
  });

  it('marks EV decisions as flow-backed when the snapshot says so', () => {
    const state = createPlanEngineState();
    const observation = buildObservation();

    const decision = decideBinaryControl({
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      deviceObservation: observation,
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: snapshot({
        id: 'ev1',
        name: 'EV',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
        flowBackedCapabilityIds: ['evcharger_charging'],
        evChargingState: 'plugged_in_charging',
      }),
      logContext: 'capacity',
      reason: 'shedding',
    });

    expect(decision).toMatchObject({
      flowBackedControl: true,
      reason: 'shedding',
    });
  });
});

describe('dispatchBinaryControlDecision (executor-side dispatcher)', () => {
  it('records pending, routes a native decision to setCapability, and emits success', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const transport = buildTransport(state, { setCapability });

    const result = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: false,
        logContext: 'capacity',
      },
      transport,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
      }),
    });

    expect(result).toEqual({ ok: true });
    expect(setCapability).toHaveBeenCalledWith('socket1', 'onoff', true);
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: true,
      flowBackedControl: false,
    });
    expect(logCapture.findEvent('binary_command_succeeded')).toMatchObject({
      deviceName: 'Socket',
      capabilityId: 'onoff',
      desired: true,
    });
  });

  it('routes a flow-backed decision through the trigger and skips setCapability', async () => {
    const state = createPlanEngineState();
    const issuedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(issuedAtMs);
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const triggerFlowBackedBinaryControl = vi.fn().mockResolvedValue(undefined);
    const transport = buildTransport(state, { setCapability, triggerFlowBackedBinaryControl });

    const result = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: false,
        flowBackedControl: true,
        logContext: 'capacity',
      },
      transport,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        flowBackedCapabilityIds: ['onoff'],
      }),
    });

    expect(result).toEqual({ ok: true });
    expect(setCapability).not.toHaveBeenCalled();
    expect(triggerFlowBackedBinaryControl).toHaveBeenCalledWith('socket1', 'onoff', false);
    // The rich-param log line (formerly the trigger-call args) is hoisted to the
    // success path and read off the decision.
    expect(logCapture.findEvent('flow_backed_binary_command_requested')).toMatchObject({
      deviceId: 'socket1',
      deviceName: 'Socket',
      capabilityId: 'onoff',
      desired: false,
      logContext: 'capacity',
    });
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: false,
      flowBackedControl: true,
    });
    expect(transport.pendingBinaryCommandStore.hasRecentConfirmedOff('socket1', 'onoff')).toBe(false);
    nowSpy.mockReturnValue(issuedAtMs + 1);
    expect(syncPendingBinaryCommands({
      store: transport.pendingBinaryCommandStore,
      liveDevices: [{
        id: 'socket1',
        name: 'Socket',
        binaryControlObservation: {
          capabilityId: 'onoff',
          observedValue: false,
          observedCapabilityIds: ['onoff'],
          observedAtMs: issuedAtMs + 1,
        },
      }],
      source: 'realtime_capability',
    })).toBe(true);
    expect(transport.pendingBinaryCommandStore.hasRecentConfirmedOff('socket1', 'onoff')).toBe(true);
    nowSpy.mockReturnValue(issuedAtMs + 80_000);
    expect(transport.pendingBinaryCommandStore.hasRecentConfirmedOff('socket1', 'onoff')).toBe(true);
    transport.pendingBinaryCommandStore.clearRecentConfirmedOff(
      'socket1',
      'onoff',
      issuedAtMs - 1,
    );
    expect(transport.pendingBinaryCommandStore.hasRecentConfirmedOff('socket1', 'onoff')).toBe(true);
    transport.pendingBinaryCommandStore.clearRecentConfirmedOff(
      'socket1',
      'onoff',
      issuedAtMs + 2,
    );
    expect(transport.pendingBinaryCommandStore.hasRecentConfirmedOff('socket1', 'onoff')).toBe(false);
  });

  it('does not attribute a later manual off to an accepted command that never converged', async () => {
    const state = createPlanEngineState();
    const issuedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(issuedAtMs);
    const transport = buildTransport(state, {
      setCapability: vi.fn(),
      triggerFlowBackedBinaryControl: vi.fn().mockResolvedValue(undefined),
    });

    expect(await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: false,
        flowBackedControl: true,
        logContext: 'capacity',
      },
      transport,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        flowBackedCapabilityIds: ['onoff'],
      }),
    })).toEqual({ ok: true });

    nowSpy.mockReturnValue(issuedAtMs + 80_000);
    expect(transport.pendingBinaryCommandStore.get('socket1')).toBeUndefined();
    expect(
      transport.pendingBinaryCommandStore.isBinaryChangeAttributableToPels('socket1', 'onoff'),
    ).toBe(false);
  });

  it('clears the recorded pending entry when dispatch fails', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn().mockRejectedValue(new Error('device unavailable'));
    const transport = buildTransport(state, { setCapability });

    const result = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: false,
        logContext: 'capacity',
      },
      transport,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'dispatch_failed' });
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logCapture.findEvent('binary_command_failed')).toMatchObject({
      reasonCode: 'device_manager_write_failed',
      deviceId: 'socket1',
    });
  });

  it('reports EV start acceptance/failure and uses the 90 second settle window', async () => {
    const state = createPlanEngineState();
    const onDispatchAccepted = vi.fn();
    const onDispatchFailed = vi.fn();
    const accepted = buildTransport(state, { setCapability: vi.fn().mockResolvedValue(undefined) }, {
      onDispatchAccepted,
      onDispatchFailed,
    });
    const decision = {
      deviceId: 'ev1',
      name: 'EV',
      capabilityId: 'evcharger_charging' as const,
      desired: true,
      flowBackedControl: false,
      logContext: 'capacity' as const,
    };

    await expect(dispatchBinaryControlDecision({ decision, transport: accepted })).resolves.toEqual({ ok: true });
    expect(state.pendingBinaryCommands.ev1?.pendingMs).toBe(90_000);
    expect(onDispatchAccepted).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'ev1', capabilityId: 'evcharger_charging', desired: true,
    }));
    expect(onDispatchFailed).not.toHaveBeenCalled();

    const failed = buildTransport(createPlanEngineState(), {
      setCapability: vi.fn().mockRejectedValue(new Error('completed')),
    }, { onDispatchFailed });
    await expect(dispatchBinaryControlDecision({ decision, transport: failed })).resolves.toEqual({
      ok: false,
      reason: 'dispatch_failed',
    });
    expect(onDispatchFailed).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'ev1' }));
  });

  it('returns dispatch_failed when the flow trigger is missing', async () => {
    const state = createPlanEngineState();
    // No flow trigger wired: the actuator's flow-backed branch rejects, so the
    // dispatch fails the same way the old missing-trigger guard did.
    const transport = buildTransport(state, { setCapability: vi.fn() });

    const result = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: true,
        logContext: 'capacity',
      },
      transport,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        flowBackedCapabilityIds: ['onoff'],
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'dispatch_failed' });
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logCapture.findEvent('flow_backed_binary_command_failed')).toMatchObject({
      reasonCode: 'flow_trigger_failed',
    });
  });
});

describe('EV start settlement evidence', () => {
  const pendingStore = () => {
    const startedMs = Date.now();
    const backing = createPlanEngineState().pendingBinaryCommands;
    const store = createPendingBinaryCommandStore(backing);
    store.record('ev1', {
      capabilityId: 'evcharger_charging',
      desired: true,
      startedMs,
      pendingMs: 90_000,
    });
    return { store, startedMs };
  };
  const binaryObservation = (startedMs: number) => ({
    capabilityId: 'evcharger_charging' as const,
    observedValue: false,
    observedAtMs: startedMs + 1_000,
    observedCapabilityIds: ['evcharger_charging', 'evcharger_charging_state'],
  });

  it('does not settle from the writable boolean echo while charging state stays idle', () => {
    const { store, startedMs } = pendingStore();
    expect(syncPendingBinaryCommands({
      store,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        evChargingState: 'plugged_in',
        binaryControlObservation: {
          ...binaryObservation(startedMs),
          observedValue: true,
          observedCapabilityIds: ['evcharger_charging'],
        },
      }],
      source: 'snapshot_refresh',
    })).toBe(false);
    expect(store.has('ev1')).toBe(true);
  });

  it('settles from fresh measured draw or associated-car charging evidence', () => {
    const { store: measuredStore, startedMs: measuredStartedMs } = pendingStore();
    expect(syncPendingBinaryCommands({
      store: measuredStore,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        evChargingState: 'plugged_in',
        measuredPowerKw: 3.7,
        measuredPowerObservedAtMs: measuredStartedMs + 1_100,
      }],
      source: 'snapshot_refresh',
    })).toBe(true);
    expect(measuredStore.has('ev1')).toBe(false);

    const { store: carStore, startedMs: carStartedMs } = pendingStore();
    expect(syncPendingBinaryCommands({
      store: carStore,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        evChargingState: 'plugged_in',
        associatedCar: {
          carId: 'car1',
          carName: 'Car',
          chargingState: 'plugged_in_charging',
          chargingStateObservedAtMs: carStartedMs + 1_200,
        },
      }],
      source: 'snapshot_refresh',
    })).toBe(true);
    expect(carStore.has('ev1')).toBe(false);
  });

  it('does not settle from pre-command measured draw or car charging evidence', () => {
    const { store: measuredStore, startedMs: measuredStartedMs } = pendingStore();
    expect(syncPendingBinaryCommands({
      store: measuredStore,
      liveDevices: [{
        id: 'ev1', name: 'EV', measuredPowerKw: 3.7, measuredPowerObservedAtMs: measuredStartedMs - 1,
      }],
      source: 'snapshot_refresh',
    })).toBe(false);
    expect(measuredStore.has('ev1')).toBe(true);

    const { store: carStore, startedMs: carStartedMs } = pendingStore();
    expect(syncPendingBinaryCommands({
      store: carStore,
      liveDevices: [{
        id: 'ev1',
        name: 'EV',
        associatedCar: {
          carId: 'car1',
          carName: 'Car',
          chargingState: 'plugged_in_charging',
          chargingStateObservedAtMs: carStartedMs - 1,
        },
      }],
      source: 'snapshot_refresh',
    })).toBe(false);
    expect(carStore.has('ev1')).toBe(true);
  });
});

describe('decideAndDispatchBinaryControl (executor-side convenience)', () => {
  it('reports not-applied without invoking dispatch when the decision is null', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn();
    const transport = buildTransport(state, { setCapability });

    const outcome = await decideAndDispatchBinaryControl({
      transport,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        binaryControl: { on: true }, // already matches
      }),
      logContext: 'capacity',
    });

    expect(outcome).toEqual({ applied: false });
    expect(setCapability).not.toHaveBeenCalled();
  });

  it('surfaces flowBacked=false for a native capability write so callers can record direct actuation', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const transport = buildTransport(state, { setCapability });

    const outcome = await decideAndDispatchBinaryControl({
      transport,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: snapshot({
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        binaryControl: { on: false },
      }),
      logContext: 'capacity',
    });

    expect(outcome).toEqual({ applied: true, flowBacked: false });
    expect(setCapability).toHaveBeenCalledWith('socket1', 'onoff', true);
  });

  it('surfaces flowBacked=true for a flow-routed write without callers re-reading the snapshot', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const triggerFlowBackedBinaryControl = vi.fn().mockResolvedValue(undefined);
    const transport = buildTransport(state, { setCapability, triggerFlowBackedBinaryControl });

    const outcome = await decideAndDispatchBinaryControl({
      transport,
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: snapshot({
        id: 'ev1',
        name: 'EV',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
        binaryControl: { on: true },
        flowBackedCapabilityIds: ['evcharger_charging'],
      }),
      logContext: 'capacity',
    });

    expect(outcome).toEqual({ applied: true, flowBacked: true });
    expect(triggerFlowBackedBinaryControl).toHaveBeenCalledWith('ev1', 'evcharger_charging', false);
    expect(setCapability).not.toHaveBeenCalled();
  });
});
