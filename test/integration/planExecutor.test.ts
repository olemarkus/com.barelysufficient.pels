import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import type Homey from 'homey';
import { PlanExecutor, type PlanExecutorDeps } from '../../lib/executor/planExecutor';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { TARGET_COMMAND_RETRY_DELAYS_MS } from '../../lib/plan/planConstants';
import { createPlanEngineState } from '../../lib/plan/planState';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { createDeviceActuator, type Actuator } from '../../lib/actuator/deviceActuator';
import { makeFlowBackedBinaryTrigger } from '../../setup/appInit/buildDeviceActuator';
import {
  observeNativeSteppedLoadCommandAdapter,
  setObservedNativeSteppedLoadStep,
} from '../../lib/device/managerNativeSteppedCommand';
import { DEVICE_LAST_CONTROLLED_MS } from '../../lib/utils/settingsKeys';
import {
  PELS_TARGET_STEP_CAPABILITY_ID,
  type SteppedLoadStepRequestResult,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type {
  BinaryControlDiscriminantProbe,
  DevicePlan,
  DevicePlanDevice,
  PlanInputDevice,
  ShedAction,
  SteppedDiscriminantProbe,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import {
  withBinaryDiscriminant,
  withSteppedDiscriminant,
  withTemperatureDiscriminant,
} from '../../lib/plan/planTypes';
import { resolvePlannedShedTargetKind } from '../../lib/plan/planActionMaterialization';
import type {
  EvObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDecoration,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import { buildLiveStatePlan } from '../../lib/plan/planLiveStateMerge';
import { hasLiveStateDivergedFromSnapshot } from '../../lib/executor/executorConvergence';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import {
  buildPlanMeta,
  fixtureResidualKw,
  resolveFixtureCurrentOn,
  withFixtureResidualKw,
  withMaterializedEvPlugState,
} from '../utils/planTestUtils';
import { createCapacityShortfallSideEffectGate } from '../../setup/capacityShortfallSideEffectGate';
import { normalizeTargetCapabilityValue } from '../../lib/utils/targetCapabilities';

const KEEP_REASON = fixtureDeviceReason('keep')!;
const CAPACITY_REASON = fixtureDeviceReason('shed due to capacity')!;

// Trusted binary evidence for an onoff device: in production a genuinely-on (or
// genuinely-off) device reports a real boolean onoff value, which the snapshot
// parser turns into `binaryControlObservation`. Tests that model a device as
// actually on/off must carry it; a snapshot with `currentOn` but no observation
// represents an UNKNOWN binary state (the prod read-failure case).
const onoffObservation = (observedValue: boolean): TargetDeviceSnapshot['binaryControlObservation'] => ({
  valid: true,
  capabilityId: 'onoff',
  observedValue,
  observedCapabilityIds: ['onoff'],
  observedAtMs: 1_000,
  source: 'snapshot_refresh',
});

/**
 * Regroup a loose plan-device fixture literal (whose moved discriminant fields —
 * `currentTarget`/`plannedTarget`, `steppedLoadProfile`, `binaryControl` — sit as
 * plain optionals) onto the discriminated `DevicePlanDevice` shape. Mirrors the
 * producer's regrouping so inline `DevicePlan.devices` fixtures keep their
 * temperature/stepped/binary semantics without per-literal casts.
 */
const pd = (
  loose: Partial<DevicePlanDevice>
    & BinaryControlDiscriminantProbe
    & SteppedDiscriminantProbe
    & {
      deviceType?: 'temperature' | 'onoff';
      currentTarget?: number;
      currentTemperature?: number;
      plannedTarget?: number;
      evChargingState?: string;
      binaryCapabilityId?: string;
    },
): DevicePlanDevice => withTemperatureDiscriminant(
  // `withMaterializedEvPlugState` regroups the way the producer does: it strips the
  // raw `evChargingState` (which the producer drops in production) and
  // materializes `commandableNow` + the EV trio in its place. Without it these
  // fixtures kept a field production removes, which is exactly why the executor's
  // EV path looked covered while `hasStableBinaryReleaseActuation` was dead.
  withSteppedDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({
    ...withMaterializedEvPlugState(loose),
    currentOn: resolveFixtureCurrentOn(loose),
    // Mirrors production's ONE stamp site (`finalizePlanDevices`): the plan's
    // shed END STATE, which is what the executor projection reads instead of
    // the shed policy. An explicit override still wins.
    plannedShedTargetKind: loose.plannedShedTargetKind
      ?? resolvePlannedShedTargetKind({
        plannedState: loose.plannedState ?? 'keep',
        shedAction: loose.shedAction,
        steppedLoadProfile: loose.steppedLoadProfile,
        plannedShedStepId: loose.plannedShedStepId,
      }),
  }))),
) as DevicePlanDevice;

const buildPlan = (): DevicePlan => ({
  meta: buildPlanMeta({
    totalKw: 1,
    softLimitKw: 5,
    headroomKw: 4}),
  devices: [
    withTemperatureDiscriminant(withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default' as const, currentDrawKw: 0,
      id: 'dev-1',
      name: 'Heater',
      commandableNow: true,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      confirmedNotDrawing: false,
      deviceType: 'temperature' as const,
      currentState: 'off',
      plannedState: 'keep' as const,
      boostActive: false,
      currentTarget: 21,
      currentTemperature: 21,
      plannedTarget: 21,
      controllable: true,
      available: true,
      currentOn: false,
      reason: KEEP_REASON,
    })),
  ],
});

const buildTargetPlan = (currentTarget = 18, plannedTarget = 23): DevicePlan => ({
  meta: buildPlanMeta({
    totalKw: 1,
    softLimitKw: 5,
    headroomKw: 4}),
  devices: [
    withTemperatureDiscriminant(withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default' as const, currentDrawKw: 0,
      id: 'dev-1',
      name: 'Heater',
      commandableNow: true,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      confirmedNotDrawing: false,
      deviceType: 'temperature' as const,
      currentState: 'on',
      plannedState: 'keep' as const,
      boostActive: false,
      currentTarget,
      currentTemperature: currentTarget,
      plannedTarget,
      controllable: true,
      available: true,
      currentOn: true,
      reason: KEEP_REASON,
    })),
  ],
});

const buildExecutor = (
  state = createPlanEngineState(),
  // Accept the loose snapshot literals call sites declare (where
  // `binaryCapabilityId` widens to `string` and richer fields like
  // `deviceClass`/`targets`/`flowBacked` may be present) and normalise to the
  // strict snapshot array the transport mock expects.
  snapshotInput: readonly (
    Partial<
      TransportDeviceSnapshot & EvObservedProbe
      & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
    > & { id: string }
  )[] = [
    {
      id: 'dev-1',
      name: 'Heater',
      binaryCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      binaryControl: { on: false },
    },
  ],
  // `structuredLog` / `debugStructured` are legacy injection points no longer on
  // `PlanExecutorDeps` (the executor logs through a module-level pino logger).
  // Tests still pass them as inert mocks for their (now trivially-true) negative
  // assertions; accept them here and strip them before the typed deps literal.
  overrides: Partial<PlanExecutorDeps> & { structuredLog?: unknown; debugStructured?: unknown } = {},
) => {
  const { structuredLog: _structuredLog, debugStructured: _debugStructuredOverride, ...depsOverrides } = overrides;
  const snapshot = snapshotInput as (TransportDeviceSnapshot & EvObservedProbe)[];
  const triggerCards = {
    desired_stepped_load_changed: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_turn_on_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_turn_off_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_start_charging_requested: { trigger: vi.fn().mockResolvedValue(true) },
    flow_backed_device_stop_charging_requested: { trigger: vi.fn().mockResolvedValue(true) },
  } as const;
  const debugStructured = vi.fn();
  const deviceManager = withGetSnapshotByDeviceId({
    getSnapshot: vi.fn().mockReturnValue(snapshot),
    setCapability: vi.fn().mockResolvedValue(undefined),
    requestSteppedLoadStep: vi.fn(async (params: {
      deviceId: string;
      profile: Parameters<typeof setObservedNativeSteppedLoadStep>[0]['profile'];
      desiredStepId: string;
      planningPowerW: number;
      planningCurrentA: number;
      previousStepId?: string;
    }): Promise<SteppedLoadStepRequestResult> => {
      const nativeRequested = await setObservedNativeSteppedLoadStep({
        owner: deviceManager,
        deviceId: params.deviceId,
        profile: params.profile,
        desiredStepId: params.desiredStepId,
        setCapability: (capabilityId, value) => deviceManager.setCapability(params.deviceId, capabilityId, value),
      });
      if (nativeRequested) return { requested: true, transport: 'native_capability' as const };
      const triggerPromise = triggerCards.desired_stepped_load_changed.trigger({
        step_id: params.desiredStepId,
        planning_power_w: params.planningPowerW,
        planning_current_a: params.planningCurrentA,
        previous_step_id: params.previousStepId ?? '',
      }, {
        deviceId: params.deviceId,
      });
      void Promise.resolve(triggerPromise);
      return { requested: true, transport: 'flow' as const };
    }),
  });
  const flowMock = {
    getTriggerCard: vi.fn((cardId: keyof typeof triggerCards) => triggerCards[cardId]),
  } as unknown as Homey.App['homey']['flow'];
  const settingsSet = vi.fn();
  const deps: PlanExecutorDeps & { homey: Homey.App['homey'] } = {
    getHomeDisplayName: () => 'Main home',
    homeId: 'main',
    setCapacityInShortfall: vi.fn(),
    // Forward the injected persist writer to the same homey.settings.set spy the
    // production wiring targets (DEVICE_LAST_CONTROLLED_MS), so the existing
    // persistence assertions keep observing the real write key.
    persistLastControlledMs: (lastControlledMs) => settingsSet(DEVICE_LAST_CONTROLLED_MS, lastControlledMs),
    homey: {
      settings: { set: settingsSet },
      flow: flowMock,
    } as unknown as Homey.App['homey'],
    deviceManager: deviceManager as never,
    getObservationRevision: () => 0,
    getObservedState: (id) => deviceManager.getSnapshotByDeviceId(id),
    // Route writes through the actuator over the SAME device-manager methods + the
    // shared production flow-trigger factory, so routing matches production wiring.
    actuator: createDeviceActuator({
      resolveTemperatureTarget: (deviceId, desired) => {
        const target = deviceManager.getSnapshotByDeviceId(deviceId)?.targets?.[0];
        if (!target) throw new Error('No temperature target binding');
        return normalizeTargetCapabilityValue({ target, value: desired });
      },
      requestBinaryControl: async (deviceId, desired) => {
        const live = deviceManager.getSnapshotByDeviceId(deviceId);
        const capabilityId = live?.binaryCapabilityId;
        if (!capabilityId) throw new Error('No binary control binding');
        if (live.flowBackedCapabilityIds?.includes(capabilityId)) {
          await makeFlowBackedBinaryTrigger(flowMock)(deviceId, capabilityId, desired);
          return;
        }
        await deviceManager.setCapability(deviceId, capabilityId, desired);
      },
      requestTemperatureTarget: async (deviceId, desired) => {
        const target = deviceManager.getSnapshotByDeviceId(deviceId)?.targets?.[0];
        if (!target) throw new Error('No temperature target binding');
        const requested = normalizeTargetCapabilityValue({ target, value: desired });
        await deviceManager.setCapability(deviceId, target.id, requested);
        return requested;
      },
      requestSteppedLoadStep: (params) => deviceManager.requestSteppedLoadStep(params),
    }),
    capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => ({ limitKw: 10, marginKw: 0 }),
    getPowerTracker: () => ({}),
    getCapacityPaceKw: () => 9.5,
    getCapacityDryRun: () => false,
    getOperatingMode: () => 'Home',
    getShedBehavior: () => ({ action: 'turn_off' as const }),
    markSteppedLoadDesiredStepIssued: vi.fn(),
    getSteppedLoadCommandSession: () => ({ hasPriorStepCommand: false, stepCommandPending: false }),
    logTargetRetryComparison: vi.fn(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
    ...depsOverrides,
  };
  return {
    executor: new PlanExecutor(deps, state),
    deps,
    deviceManager,
    state,
    desiredSteppedTrigger: triggerCards.desired_stepped_load_changed,
    flowBackedTurnOnTrigger: triggerCards.flow_backed_device_turn_on_requested,
    flowBackedTurnOffTrigger: triggerCards.flow_backed_device_turn_off_requested,
    flowBackedStartChargingTrigger: triggerCards.flow_backed_device_start_charging_requested,
    flowBackedStopChargingTrigger: triggerCards.flow_backed_device_stop_charging_requested,
    debugStructured,
  };
};

let logCapture: LoggerCapture;
beforeEach(() => { logCapture = captureLogger(); });
afterEach(() => { logCapture.restore(); });

// The merge asks the pending-command store whether a turn-ON is in flight;
// these specs issue no commands.
const noPendingBinary = (): boolean => false;

describe('PlanExecutor shortfall side-effect retry', () => {
  it('keeps enter and clear retryable when the durable writer fails once', async () => {
    const state = createPlanEngineState();
    let failNextWrite = true;
    const setCapacityInShortfall = vi.fn((_value: boolean) => {
      if (!failNextWrite) return;
      failNextWrite = false;
      throw new Error('settings unavailable');
    });
    const { executor } = buildExecutor(state, undefined, {
      setCapacityInShortfall,
    });
    const gate = createCapacityShortfallSideEffectGate({
      isDiscarded: () => false,
      isTemporarilyFenced: () => false,
      applyShortfall: (deficitKw) => executor.handleShortfall(deficitKw),
      applyClear: () => executor.handleShortfallCleared(),
    });

    await expect(gate.onShortfall(2)).rejects.toThrow('settings unavailable');
    expect(state.inShortfall).toBe(false);

    await expect(gate.flush()).resolves.toBe(true);
    expect(state.inShortfall).toBe(true);

    failNextWrite = true;
    await expect(gate.onShortfallCleared()).rejects.toThrow('settings unavailable');
    expect(state.inShortfall).toBe(true);
    await expect(gate.flush()).resolves.toBe(true);
    expect(state.inShortfall).toBe(false);
    expect(setCapacityInShortfall.mock.calls.map(([value]) => value))
      .toEqual([true, true, false, false]);
  });

  it('emits deferred state transitions after Builder pre-sync', async () => {
    const state = createPlanEngineState();
    state.inShortfall = true;
    const setCapacityInShortfall = vi.fn();
    const { executor } = buildExecutor(state, undefined, {
      setCapacityInShortfall,
    });
    const gate = createCapacityShortfallSideEffectGate({
      isDiscarded: () => false,
      isTemporarilyFenced: () => false,
      applyShortfall: (deficitKw) => executor.handleShortfall(deficitKw),
      applyClear: () => executor.handleShortfallCleared(),
    });

    // Builder already persisted/synchronized the guard state while the
    // immediate state callback was fenced. Executor must still apply it.
    await gate.onShortfall(1);
    expect(setCapacityInShortfall).not.toHaveBeenCalled();

    // Model Builder pre-syncing the clear before the retained callback lands.
    state.inShortfall = false;
    await gate.onShortfallCleared();
    state.inShortfall = true;
    await gate.onShortfall(2);

    expect(setCapacityInShortfall).not.toHaveBeenCalled();
  });

  it('holds a pre-existing deferred transition until a superseding sample settles', async () => {
    let authorityFenced = true;
    const applyShortfall = vi.fn().mockResolvedValue(undefined);
    const scheduleRetry = vi.fn();
    const gate = createCapacityShortfallSideEffectGate({
      isDiscarded: () => false,
      isTemporarilyFenced: () => authorityFenced,
      scheduleRetry,
      applyShortfall,
      applyClear: vi.fn().mockResolvedValue(undefined),
    });

    // The transition predates recovery, so it was initially deferred by
    // authority rather than by an active prepared sample fence.
    await gate.onShortfall(2);
    gate.holdDeferredUntilPreparedApply();
    authorityFenced = false;

    await expect(gate.flush()).resolves.toBe(false);
    expect(applyShortfall).not.toHaveBeenCalled();

    // A later sample becoming stable is not enough: its rebuild may have
    // failed before CapacityGuard adopted that measurement.
    await expect(gate.flush()).resolves.toBe(false);
    expect(applyShortfall).not.toHaveBeenCalled();

    await expect(gate.flushAfterPreparedApply()).resolves.toBe(true);
    expect(applyShortfall).toHaveBeenCalledExactlyOnceWith(2);
    expect(scheduleRetry).toHaveBeenCalled();
  });
});

describe('PlanExecutor declined actuator requests', () => {
  it('does not record a fenced binary request as a write or leave pending state', async () => {
    const state = createPlanEngineState();
    const apply = vi.fn(async () => ({ requested: false as const }));
    const actuator: Actuator = {
      apply,
      resolveTemperatureTarget: (_deviceId, desired) => desired,
    };
    const persistLastControlledMs = vi.fn();
    const { executor } = buildExecutor(state, [{
      id: 'dev-1',
      name: 'Heater',
      binaryCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
    }], {
      actuator,
      persistLastControlledMs,
    });

    const result = await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 6,
        softLimitKw: 5,
        headroomKw: -1}),
      devices: [pd({
        id: 'dev-1',
        name: 'Heater',
        currentState: 'on',
        plannedState: 'shed',
        boostActive: false,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
        controllable: true,
        binaryCapabilityId: 'onoff',
        reason: CAPACITY_REASON,
      })],
    });

    expect(apply).toHaveBeenCalledWith({
      kind: 'binary',
      deviceId: 'dev-1',
      desired: false,
    });
    expect(result).toEqual({ deviceWriteCount: 0, commandRequestCount: 0, writtenDeviceIds: [] });
    expect(state.pendingBinaryCommands['dev-1']).toBeUndefined();
    expect(state.lastDeviceShedMs['dev-1']).toBeUndefined();
    expect(state.lastDeviceControlledMs['dev-1']).toBeUndefined();
    expect(state.lastInstabilityMs).toBeNull();
    expect(persistLastControlledMs).not.toHaveBeenCalled();
    expect(logCapture.findEvent('binary_command_succeeded')).toBeUndefined();
    expect(logCapture.findEvent('binary_command_applied')).toBeUndefined();
  });

  it('does not record a fenced target request as a write or pending retry', async () => {
    const state = createPlanEngineState();
    const apply = vi.fn(async () => ({ requested: false as const }));
    const actuator: Actuator = {
      apply,
      resolveTemperatureTarget: (_deviceId, desired) => desired,
    };
    const persistLastControlledMs = vi.fn();
    const { executor } = buildExecutor(state, [{
      id: 'dev-1',
      expectedPowerKw: 1,
      name: 'Heater',
      binaryCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
      targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
    }], {
      actuator,
      persistLastControlledMs,
    });

    const result = await executor.applyPlanActions(buildTargetPlan());

    expect(apply).toHaveBeenCalledWith({
      kind: 'target',
      deviceId: 'dev-1',
      target: 'temperature',
      value: 23,
    });
    expect(result).toEqual({ deviceWriteCount: 0, commandRequestCount: 0, writtenDeviceIds: [] });
    expect(state.pendingTargetCommands['dev-1']).toBeUndefined();
    expect(state.lastDeviceRestoreMs['dev-1']).toBeUndefined();
    expect(state.lastDeviceControlledMs['dev-1']).toBeUndefined();
    expect(state.lastRestoreMs).toBeNull();
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
    expect(persistLastControlledMs).not.toHaveBeenCalled();
    expect(logCapture.findEvent('target_command_applied')).toBeUndefined();
  });
});

describe('PlanExecutor restore logging', () => {
  it('continues applying later devices when stepped-load projection fails for one device', async () => {
    const snapshot = [
      {
        id: 'bad-step',
        name: 'Bad stepped load',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
      {
        id: 'dev-1',
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await expect(executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 2,
        softLimitKw: 1,
        headroomKw: -1}),
      devices: [
        pd({
          id: 'bad-step',
          name: 'Bad stepped load',
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          controllable: true,
          reason: KEEP_REASON,
          steppedLoadProfile: {} as never,
          // The malformed ladder is this test's SUBJECT: the executor must keep
          // going when stepped projection fails. The producer resolves the
          // residual before any ladder reaches a plan and can never be handed
          // this shape, so resolve it here for the same device WITHOUT the
          // broken profile.
          residualKw: fixtureResidualKw({ currentDrawKw: 0, expectedPowerKw: 1 }),
        }),
        pd({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'on',
          plannedState: 'shed',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: true,
          binaryCapabilityId: 'onoff',
          reason: CAPACITY_REASON,
        }),
      ],
    })).resolves.toEqual({
      deviceWriteCount: 1,
      commandRequestCount: 0,
      // Names the device actually written, not the one that threw and not both.
      // The realtime circuit breaker charges a strike per id in this list, so a
      // wrong id here suppresses an innocent device's observations for 60 s.
      writtenDeviceIds: ['dev-1'],
    });

    expect(logCapture.events).toContainEqual(expect.objectContaining({
      msg: 'Failed to apply action for Bad stepped load; continuing with remaining devices',
    }));
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it.each([
    { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 30 },
    { code: PLAN_REASON_CODES.meterSettling, remainingSec: 30 },
  ] as const)('does not turn off binary devices during restore-admission hold reason $code', async (reason) => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: true,
          reason,
        }),
      ],
    });

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not turn off a pending swap target that is already observed on', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: true,
          reason: { code: PLAN_REASON_CODES.swapPending, targetName: null },
        }),
      ],
    });

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not lower a pending swap target temperature', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'on',
          plannedState: 'shed',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 16,
          controllable: true,
          shedAction: 'set_temperature',
          reason: { code: PLAN_REASON_CODES.swapPending, targetName: null },
        }),
      ],
    });

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not restore a pending swap target even if it has keep intent', async () => {
    const { executor, deviceManager } = buildExecutor();

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: true,
          reason: { code: PLAN_REASON_CODES.swapPending, targetName: null },
        }),
      ],
    });

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not emit EV restore evaluation logs for controlled EVs already observed on', async () => {
    const { executor, deviceManager } = buildExecutor(undefined, [{
      id: 'dev-1',
      name: 'EV Charger',
      deviceClass: 'evcharger',
      binaryCapabilityId: 'evcharger_charging',
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
      evChargingState: 'plugged_in_charging',
    }]);

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1',
          name: 'EV Charger',
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: true,
          reason: KEEP_REASON,
        }),
      ],
    });

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'evcharger_charging', true);
    expect(logCapture.events.every((e) => typeof e.msg !== 'string' || !e.msg.includes('evaluating EV restore'))).toBe(true);
  });

  it('does not emit EV restore evaluation logs for uncontrolled EVs already observed on', async () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-1'] = Date.now() - 10_000;
    const { executor, deviceManager } = buildExecutor(state, [{
      id: 'dev-1',
      name: 'EV Charger',
      deviceClass: 'evcharger',
      binaryCapabilityId: 'evcharger_charging',
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
      evChargingState: 'plugged_in_charging',
    }]);

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1',
          name: 'EV Charger',
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: false,
          reason: KEEP_REASON,
        }),
      ],
    });

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'evcharger_charging', true);
    expect(logCapture.events.every((e) => typeof e.msg !== 'string' || !e.msg.includes('evaluating EV restore'))).toBe(true);
  });

  it('logs restore from shed state when the device has not been restored since the last shed', async () => {
    const state = createPlanEngineState();
    state.shedDecidedMs['dev-1'] = Date.now() - 10_000;
    const { executor, deviceManager } = buildExecutor(state);

    await executor.applyPlanActions(buildPlan());

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_succeeded',
      msg: 'Capacity: turning on Heater (restored from shed state)',
    }));
  });

  it('does not actuate a binary restore while meter settling keeps an off device in keep state', async () => {
    const { executor, deviceManager } = buildExecutor();

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: true,
          reason: fixtureDeviceReason('meter settling (30s remaining)'),
        }),
      ],
    });

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('requests flow-backed on/off control through the Homey trigger instead of writing the device capability', async () => {
    const { executor, deviceManager, flowBackedTurnOffTrigger, state } = buildExecutor(
      createPlanEngineState(),
      [{
        id: 'dev-1',
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        flowBacked: true,
        flowBackedCapabilityIds: ['onoff'],
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      }],
    );

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 6,
        softLimitKw: 5,
        headroomKw: -1}),
      devices: [pd({
        id: 'dev-1',
        name: 'Heater',
        currentState: 'on',
        plannedState: 'shed',
        boostActive: false,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
        controllable: true,
        binaryCapabilityId: 'onoff',
        reason: CAPACITY_REASON,
      })],
    });

    expect(flowBackedTurnOffTrigger.trigger).toHaveBeenCalledWith(
      {},
      { deviceId: 'dev-1' },
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_succeeded',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      controlAxis: 'binary',
      desired: false,
      logContext: 'capacity',
    }));
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'binary_command_applied',
      deviceId: 'dev-1',
    }));
    expect(state.lastDeviceShedMs['dev-1']).toBeUndefined();
    expect(state.pendingBinaryCommands['dev-1']).toMatchObject({
      desired: false,
    });
  });

  it('records a fast flow-backed restore confirmation exactly once', async () => {
    const state = createPlanEngineState();
    state.shedDecidedMs['dev-1'] = Date.now() - 10_000;
    state.swapByDevice['dev-1'] = {
      pendingTarget: true,
      timestamp: Date.now() - 1_000,
    };
    const { executor, deviceManager, flowBackedTurnOnTrigger } = buildExecutor(
      state,
      [{
        id: 'dev-1',
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        flowBacked: true,
        flowBackedCapabilityIds: ['onoff'],
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      }],
    );

    flowBackedTurnOnTrigger.trigger.mockImplementation(async () => {
      const pending = state.pendingBinaryCommands['dev-1'];
      expect(pending).toMatchObject({ desired: true });
      syncPendingBinaryCommands({
        store: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        liveDevices: [{
          id: 'dev-1',
          name: 'Heater',
          binaryCommandConfirmation: {
            state: 'observed',
            observedValue: true,
            observedAtMs: pending.startedMs + 1,
          },
        }],
        source: 'device_update',
        onConfirmed: (params) => executor.handleConfirmedBinaryCommand(params),
      });
    });

    await executor.applyPlanActions(buildPlan());

    expect(flowBackedTurnOnTrigger.trigger).toHaveBeenCalledWith(
      {},
      { deviceId: 'dev-1' },
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    const acceptedPending = state.pendingBinaryCommands['dev-1'];
    syncPendingBinaryCommands({
      store: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      liveDevices: [{
        id: 'dev-1', name: 'Heater',
        binaryCommandConfirmation: {
          state: 'observed', observedValue: true, observedAtMs: acceptedPending.startedMs + 1,
        },
      }],
      source: 'rebuild',
      onConfirmed: (params) => executor.handleConfirmedBinaryCommand(params),
    });
    expect(state.pendingBinaryCommands['dev-1']).toBeUndefined();

    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_applied',
      deviceId: 'dev-1',
      desired: true,
      reasonCode: 'shed_state',
    }));
    expect(state.lastDeviceRestoreMs['dev-1']).toEqual(expect.any(Number));
    expect(state.lastDeviceControlledMs['dev-1']).toEqual(expect.any(Number));
    expect(state.activationAttemptByDevice['dev-1']).toMatchObject({
      startedMs: expect.any(Number),
      source: 'pels_restore',
    });
    expect(state.swapByDevice['dev-1']).toBeUndefined();
    expect(logCapture.events.filter((event) => (
      event.event === 'binary_command_applied' && event.deviceId === 'dev-1'
    ))).toHaveLength(1);
  });

  it('records flow-backed shed accounting only after observed confirmation', async () => {
    const state = createPlanEngineState();
    const { executor } = buildExecutor(
      state,
      [{
        id: 'dev-1',
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        flowBacked: true,
        flowBackedCapabilityIds: ['onoff'],
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      }],
    );

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 6,
        softLimitKw: 5,
        headroomKw: -1}),
      devices: [pd({
        id: 'dev-1',
        name: 'Heater',
        currentState: 'on',
        plannedState: 'shed',
        boostActive: false,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
        controllable: true,
        binaryCapabilityId: 'onoff',
        reason: CAPACITY_REASON,
      })],
    });

    expect(state.lastDeviceShedMs['dev-1']).toBeUndefined();
    const pending = state.pendingBinaryCommands['dev-1'];
    expect(pending).toMatchObject({ desired: false });

    executor.handleConfirmedBinaryCommand({
      deviceId: 'dev-1', liveDevice: { id: 'dev-1', name: 'Heater' }, pending,
    });

    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_applied',
      deviceId: 'dev-1',
      desired: false,
      reasonCode: 'shedding',
    }));
    expect(state.lastDeviceShedMs['dev-1']).toEqual(expect.any(Number));
    expect(state.lastDeviceControlledMs['dev-1']).toEqual(expect.any(Number));
  });

  it('logs neutral restore text when matching the current plan after a later external off', async () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-1'] = Date.now() - 20_000;
    state.lastDeviceRestoreMs['dev-1'] = Date.now() - 5_000;
    const { executor, deviceManager } = buildExecutor(state);

    await executor.applyPlanActions(buildPlan());

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_succeeded',
      msg: 'Capacity: turning on Heater (to match current plan)',
    }));
  });

  // Every restore actuation stamps the 60-300 s restore cooldown and opens an
  // activation attempt. This used to be gated on `mode === 'plan'`, so a
  // reconcile-driven restore armed no cooldown at all and instead recorded an
  // activation SETBACK — half of how a re-assert could outrun the planner in
  // inc_26449fb9. There is one actuation path now, and it always stamps.
  it('starts a restore cycle whenever it turns a device back on', async () => {
    const state = createPlanEngineState();
    state.lastRestoreMs = Date.now() - 30_000;
    state.lastDeviceRestoreMs['dev-1'] = state.lastRestoreMs;
    const previousLastRestoreMs = state.lastRestoreMs;
    const previousDeviceRestoreMs = state.lastDeviceRestoreMs['dev-1'];
    const { executor, deviceManager, state: nextState } = buildExecutor(state);

    await executor.applyPlanActions(buildPlan());

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    const restorePending = nextState.pendingBinaryCommands['dev-1'];
    syncPendingBinaryCommands({
      store: createPendingBinaryCommandStore(nextState.pendingBinaryCommands),
      liveDevices: [{
        id: 'dev-1',
        name: 'Heater',
        binaryCommandConfirmation: {
          state: 'observed', observedValue: true, observedAtMs: restorePending.startedMs + 1,
        },
      }],
      source: 'device_update',
      onConfirmed: (params) => executor.handleConfirmedBinaryCommand(params),
    });
    expect(nextState.lastRestoreMs).toBeGreaterThan(previousLastRestoreMs);
    expect(nextState.lastDeviceRestoreMs['dev-1']).toBeGreaterThan(previousDeviceRestoreMs);
    expect(nextState.activationAttemptByDevice['dev-1']).toEqual(expect.objectContaining({
      startedMs: expect.any(Number),
    }));
  });

  it('closes a plan-mode shed attempt without bumping penalty and emits shed diagnostics', async () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      startedMs: now - 5_000,
      source: 'pels_restore',
    };
    const deviceDiagnostics = {
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
    };
    const { executor, deviceManager, state: nextState } = buildExecutor(state, [{
      id: 'dev-1',
      name: 'Heater',
      binaryCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
    }], {
      deviceDiagnostics: deviceDiagnostics as any,
    });

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 6,
        softLimitKw: 5,
        headroomKw: -1}),
      devices: [pd({
        id: 'dev-1',
        name: 'Heater',
        currentState: 'on',
        plannedState: 'shed',
        boostActive: false,
        currentTarget: 21,
        currentTemperature: 21,
        plannedTarget: 21,
        controllable: true,
        binaryCapabilityId: 'onoff',
        reason: CAPACITY_REASON,
      })],
    });

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    const shedPending = nextState.pendingBinaryCommands['dev-1'];
    syncPendingBinaryCommands({
      store: createPendingBinaryCommandStore(nextState.pendingBinaryCommands),
      liveDevices: [{
        id: 'dev-1',
        name: 'Heater',
        binaryCommandConfirmation: {
          state: 'observed', observedValue: false, observedAtMs: shedPending.startedMs + 1,
        },
      }],
      source: 'device_update',
      onConfirmed: (params) => executor.handleConfirmedBinaryCommand(params),
    });
    expect(nextState.activationAttemptByDevice['dev-1']).toEqual(expect.objectContaining({ penaltyLevel: 2 }));
    expect(deviceDiagnostics.recordControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pels_shed',
      deviceId: 'dev-1',
      name: 'Heater',
    }));
    expect(deviceDiagnostics.recordActivationTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'attempt_closed_by_shed',
        deviceId: 'dev-1',
        penaltyLevel: 2,
        source: 'pels_restore',
      }),
      { name: 'Heater' },
    );
  });

  it('logs restore from shed temperature as explicit capacity work', async () => {
    const state = createPlanEngineState();
    const { executor, deviceManager } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 16, unit: '°C' }],
      },
    ], {
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 16 }),
    });

    await executor.applyPlanActions(buildTargetPlan(16, 23));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      target: 'temperature',
      targetValue: 23,
      previousValue: 16,
      attemptType: 'send',
      reasonCode: 'restore_from_shed',
      operatingMode: 'Home',
    }));
  });
});

describe('PlanExecutor pending target commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resend the same target command until the retry deadline', async () => {
    const state = createPlanEngineState();
    const { executor, deviceManager, state: nextState, deps } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      },
    ]);
    const plan = buildTargetPlan();

    await executor.applyPlanActions(plan);
    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      target: 'temperature',
      desired: 23,
      retryCount: 0,
    });
    vi.advanceTimersByTime(90_000 - 1);
    await executor.applyPlanActions(plan);
    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(2);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      target: 'temperature',
      desired: 23,
      retryCount: 1,
    });
    expect(logCapture.events).toContainEqual(expect.objectContaining({ msg: 'Target mismatch still present for Heater; observed 18°C via unknown, retrying temperature to 23°C' }));
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      target: 'temperature',
      targetValue: 23,
      previousValue: 18,
      attemptType: 'retry',
      reasonCode: 'retry_pending_confirmation',
      operatingMode: 'Home',
    }));
    expect(deps.logTargetRetryComparison).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      name: 'Heater',
      target: 'temperature',
      desired: 23,
      observedValue: 18,
      observedSource: undefined,
      retryCount: 1,
      skipContext: 'plan',
    });
  });

  it('backs off failed target writes and marks the device temporarily unavailable', async () => {
    const state = createPlanEngineState();
    const failure = new Error('Device offline');
    const { executor, deviceManager, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      },
    ]);
    deviceManager.setCapability.mockRejectedValue(failure);
    const plan = buildTargetPlan();

    await executor.applyPlanActions(plan);
    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      target: 'temperature',
      desired: 23,
      retryCount: 0,
      status: 'temporary_unavailable',
    });
    expect(logCapture.events).toContainEqual(expect.objectContaining({ msg: 'Failed to set temperature for Heater; treating device as temporarily unavailable for 30s before retry' }));
    expect(logCapture.events).toContainEqual(expect.objectContaining({ msg: 'Failed to set temperature for Heater via DeviceTransport' }));
    expect(logCapture.events).toContainEqual(expect.objectContaining({ msg: 'Capacity: skip temperature for Heater, device temporarily unavailable for 30s before retry (plan)' }));
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'target_command_failed',
      reasonCode: 'device_manager_write_failed',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      target: 'temperature',
      desired: 23,
      skipContext: 'plan',
    }));
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'target_command_skipped',
      reasonCode: 'temporarily_unavailable',
      deviceId: 'dev-1',
      target: 'temperature',
      desired: 23,
      skipContext: 'plan',
    }));
  });

  it('logs restore skips when the target snapshot is missing', async () => {
    const state = createPlanEngineState();
    state.lastDeviceShedMs['dev-1'] = Date.now() - 10_000;
    const { executor, deviceManager } = buildExecutor(state, []);

    await executor.applyPlanActions(buildPlan());

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'missing_snapshot',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      logContext: 'capacity',
    }));
  });

  it('falls back to turn_off shedding when a shed temperature write fails', async () => {
    const state = createPlanEngineState();
    const failure = new Error('Device offline');
    const { executor, deviceManager, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 22, unit: '°C' }],
      },
    ], {
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15 }),
    });
    deviceManager.setCapability.mockImplementation(async (_deviceId: string, capabilityId: string) => {
      if (capabilityId === 'target_temperature') throw failure;
    });

    await executor.applySheddingToDevice('dev-1', 'Heater');

    expect(deviceManager.setCapability).toHaveBeenNthCalledWith(1, 'dev-1', 'target_temperature', 15);
    expect(deviceManager.setCapability).toHaveBeenNthCalledWith(2, 'dev-1', 'onoff', false);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      target: 'temperature',
      desired: 15,
      status: 'temporary_unavailable',
    });
  });

  it('does not fall back to turn_off when shed temperature is already applied', async () => {
    const { executor, deviceManager } = buildExecutor(createPlanEngineState(), [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 15, unit: '°C' }],
      },
    ], {
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15 }),
    });

    await expect(executor.applySheddingToDevice('dev-1', 'Heater')).resolves.toBe(false);

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it('tags plan-driven target updates in the user-visible log', async () => {
    const state = createPlanEngineState();
    const { executor, deviceManager } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      },
    ]);

    await executor.applyPlanActions(buildTargetPlan());

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      target: 'temperature',
      targetValue: 23,
      previousValue: 18,
      attemptType: 'send',
      reasonCode: 'plan_update',
      operatingMode: 'Home',
    }));
  });

  it('normalizes target writes to the device target step before tracking pending retries', async () => {
    const state = createPlanEngineState();
    const { executor, deviceManager, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Connected 300',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 40, unit: '°C', min: 35, max: 75, step: 5 }],
      },
    ]);

    await executor.applyPlanActions(buildTargetPlan(40, 46));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 45);
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      target: 'temperature',
      desired: 45,
      retryCount: 0,
    });
    await executor.applyPlanActions(buildTargetPlan(40, 46));
    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
  });

  it('logs shed-temperature target updates as shedding work instead of overshoot', async () => {
    const state = createPlanEngineState();
    const { executor, deviceManager } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 22, unit: '°C' }],
      },
    ], {
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15 }),
    });

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1',
          name: 'Heater',
          deviceType: 'temperature',
          currentState: 'on',
          plannedState: 'shed',
          boostActive: false,
          currentTarget: 22,
          currentTemperature: 22,
          plannedTarget: 15,
          controllable: true,
          shedAction: 'set_temperature',
        }),
      ],
    });

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 15);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      target: 'temperature',
      targetValue: 15,
      previousValue: 22,
      attemptType: 'send',
      reasonCode: 'shedding',
    }));
  });

  // Retry backoff is now respected unconditionally. `mode === 'reconcile'` used to
  // bypass it (a re-assert had no pending-command bookkeeping of its own), which is
  // half of how a re-assert could outrun the planner in inc_26449fb9. A pending
  // command still inside its backoff window must suppress the write.
  it('respects pending target retry backoff instead of writing again immediately', async () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      target: 'temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      pendingMs: 90_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + TARGET_COMMAND_RETRY_DELAYS_MS[0],
      status: 'waiting_confirmation',
      lastObservedValue: 18,
      lastObservedSource: 'rebuild',
      lastObservedAtMs: Date.now() - 5_000,
    };
    const { executor, deviceManager, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 28, unit: '°C' }],
      },
    ]);

    await executor.applyPlanActions(buildTargetPlan(28, 23));

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    // The pending entry is left untouched — no attempt was made, so nothing to count.
    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      desired: 23,
      retryCount: 0,
    });
  });

  it('clears a pending target retry when the live snapshot is already confirmed after actuation', async () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      target: 'temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      pendingMs: 90_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + TARGET_COMMAND_RETRY_DELAYS_MS[0],
      status: 'waiting_confirmation',
      lastObservedValue: 25,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 5_000,
    };
    const snapshot = [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 25, unit: '°C' }],
      },
    ];
    const syncLivePlanStateAfterTargetActuation = vi.fn(() => {
      snapshot[0].targets[0].value = 23;
      return true;
    });
    const { executor, deviceManager, state: nextState } = buildExecutor(
      state,
      snapshot,
      { syncLivePlanStateAfterTargetActuation },
    );

    vi.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[0] + 1);
    await executor.applyPlanActions(buildTargetPlan(25, 23));

    expect(deviceManager.setCapability).toHaveBeenCalledTimes(1);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
    expect(syncLivePlanStateAfterTargetActuation).toHaveBeenCalledWith('realtime_capability');
    expect(nextState.pendingTargetCommands['dev-1']).toBeUndefined();
    expect(logCapture.events.every((e) => typeof e.msg !== 'string' || !e.msg.includes('Target mismatch still present for Heater'))).toBe(true);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'target_command_applied',
      deviceId: 'dev-1',
      target: 'temperature',
      targetValue: 23,
      previousValue: 25,
      attemptType: 'retry',
      reasonCode: 'retry_pending_confirmation',
    }));
    expect(logCapture.events).toContainEqual(expect.objectContaining({ msg: 'Capacity: confirmed temperature for Heater at 23°C immediately after actuation' }));
  });

  it('keeps retry observation metadata aligned with the live snapshot instead of a stale plan currentTarget', async () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      target: 'temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      pendingMs: 90_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + TARGET_COMMAND_RETRY_DELAYS_MS[0],
      status: 'waiting_confirmation',
      lastObservedValue: 27,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 5_000,
    };
    const { executor, state: nextState } = buildExecutor(state, [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 25, unit: '°C' }],
      },
    ]);

    vi.advanceTimersByTime(TARGET_COMMAND_RETRY_DELAYS_MS[0] + 1);
    await executor.applyPlanActions(buildTargetPlan(18, 23));

    expect(nextState.pendingTargetCommands['dev-1']).toMatchObject({
      desired: 23,
      retryCount: 1,
      lastObservedValue: 25,
    });
  });
});

describe('PlanExecutor stepped loads', () => {
  const steppedProfile = {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'max', planningPowerW: 3000 },
    ],
  };

  const steppedSnapshot = (
    overrides: Partial<
      TransportDeviceSnapshot & EvObservedProbe & SteppedLoadDecoration
      & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
    > = {},
  ): (TransportDeviceSnapshot & EvObservedProbe)[] => [{
    id: 'dev-1',
    expectedPowerKw: 1,
    name: 'Tank',
    binaryCapabilityId: 'onoff',
    canSetControl: true,
    available: true,
    binaryControl: { on: true },
    targets: [],
    controlModel: 'stepped_load',
    steppedLoadProfile: steppedProfile,
    reportedStepId: 'low',
    ...overrides,
  } as TransportDeviceSnapshot & EvObservedProbe];

  const steppedPlan = (overrides: Record<string, unknown> = {}): DevicePlan => {
    const merged = {
      id: 'dev-1',
      name: 'Tank',
      deviceType: 'temperature' as const,
      plannedState: 'keep' as const,
      boostActive: false,
      currentTarget: 68,
      currentTemperature: 68,
      plannedTarget: 68,
      controllable: true,
      available: true,
      binaryCapabilityId: 'onoff' as const,
      reason: KEEP_REASON,
      commandableNow: true,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      confirmedNotDrawing: false,
      steppedLoadProfile: steppedProfile,
      reportedStepId: 'low',
      selectedStepId: 'low',
      desiredStepId: 'max',
      ...overrides,
    };
    return {
      meta: buildPlanMeta({
        totalKw: 1,
        softLimitKw: 5,
        headroomKw: 4}),
      devices: [
        withTemperatureDiscriminant(withSteppedDiscriminant(withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default' as const, currentDrawKw: 0,
          ...merged,
          currentState: (merged as { currentState?: string }).currentState ?? 'on',
          currentOn: resolveFixtureCurrentOn(merged),
          // Mirrors production's ONE stamp site (`finalizePlanDevices`): the
          // plan's shed END STATE, which the executor projection reads instead
          // of the shed policy. This builder does not go through `pd()`.
          // `merged` spreads a `Record<string, unknown>` override bag, so its
          // declared property types are already widened — the double cast is the
          // same fixture-boundary move the other builders in this file make.
          plannedShedTargetKind: resolvePlannedShedTargetKind(
            merged as unknown as {
              plannedState: 'shed' | 'keep' | 'inactive';
              shedAction?: ShedAction;
              steppedLoadProfile?: SteppedLoadProfile;
              plannedShedStepId?: string;
            },
          ),
        }))),
      ],
    };
  };

  it('initializes an unknown running stepped load at its lowest step before ramping higher', async () => {
    const { executor, deviceManager, desiredSteppedTrigger, state, deps } = buildExecutor(
      undefined,
      steppedSnapshot({
        reportedStepId: undefined,
        binaryControlObservation: onoffObservation(true),
      }),
    );

    await expect(executor.applyPlanActions(steppedPlan({
      reportedStepId: undefined,
    }))).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 1,
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
      step_id: 'low',
      planning_power_w: 1250,
      planning_current_a: 0,
      previous_step_id: '',
    }, {
      deviceId: 'dev-1',
    });
    expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      desiredStepId: 'low',
      confirmationPolicy: 'assume_applied',
      issuedAtMs: expect.any(Number),
    });
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_requested',
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      desiredStepId: 'low',
      commandPurpose: 'step_initialization',
      plannedDesiredStepId: 'max',
    }));
    expect(state.lastRestoreMs).toBeNull();
  });

  it('does not initialize when a real level report arrives after planning', async () => {
    const { executor, desiredSteppedTrigger, deps } = buildExecutor(
      undefined,
      steppedSnapshot({
        reportedStepId: 'max',
        selectedStepId: 'max',
        binaryControlObservation: onoffObservation(true),
      }),
      {
        getSteppedLoadCommandSession: () => ({
          hasPriorStepCommand: false,
          stepCommandPending: false,
          reportedStepId: 'low',
        }),
      },
    );

    await expect(executor.applyPlanActions(steppedPlan({
      reportedStepId: undefined,
      selectedStepId: 'low',
      desiredStepId: 'max',
    }))).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 0,
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
  });

  it('uses an admitted flow level report that is not present in the raw transport snapshot', async () => {
    const { executor, desiredSteppedTrigger, deps } = buildExecutor(
      undefined,
      steppedSnapshot({
        reportedStepId: undefined,
        binaryControlObservation: onoffObservation(true),
      }),
      {
        getSteppedLoadCommandSession: () => ({
          hasPriorStepCommand: false,
          stepCommandPending: false,
          reportedStepId: 'max',
        }),
      },
    );

    await expect(executor.applyPlanActions(steppedPlan({
      reportedStepId: undefined,
      selectedStepId: 'low',
      desiredStepId: 'max',
    }))).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 0,
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
  });

  it('keeps initialization eligible when the transport rejects the low-step request', async () => {
    const { executor, deviceManager, deps } = buildExecutor(
      undefined,
      steppedSnapshot({
        reportedStepId: undefined,
        binaryControlObservation: onoffObservation(true),
      }),
    );
    deviceManager.requestSteppedLoadStep.mockResolvedValue({ requested: false });

    const plan = steppedPlan({ reportedStepId: undefined });
    await expect(executor.applyPlanActions(plan)).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 0,
    }));
    await expect(executor.applyPlanActions(plan)).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 0,
    }));

    expect(deviceManager.requestSteppedLoadStep).toHaveBeenCalledTimes(2);
    expect(deviceManager.requestSteppedLoadStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ desiredStepId: 'low', previousStepId: undefined }),
    );
    expect(deviceManager.requestSteppedLoadStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ desiredStepId: 'low', previousStepId: undefined }),
    );
    expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
  });

  it('ramps to the planned higher step after initialization without waiting for level feedback', async () => {
    const { executor, desiredSteppedTrigger, deps } = buildExecutor(
      undefined,
      steppedSnapshot({
        reportedStepId: undefined,
        binaryControlObservation: onoffObservation(true),
      }),
      {
        getSteppedLoadCommandSession: () => ({
          initializationAssumedStepId: 'low',
          hasPriorStepCommand: false,
          stepCommandPending: false,
        }),
      },
    );

    await expect(executor.applyPlanActions(steppedPlan({
      reportedStepId: undefined,
    }))).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 1,
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
      step_id: 'max',
      planning_power_w: 3000,
      planning_current_a: 0,
      previous_step_id: 'low',
    }, {
      deviceId: 'dev-1',
    });
    expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: expect.any(Number),
      pendingWindowMs: expect.any(Number),
    });
  });

  it('does not repeat initialization when the assumed lowest step remains the planned target', async () => {
    const { executor, desiredSteppedTrigger, deps } = buildExecutor(
      undefined,
      steppedSnapshot({
        reportedStepId: undefined,
        binaryControlObservation: onoffObservation(true),
      }),
      {
        getSteppedLoadCommandSession: () => ({
          initializationAssumedStepId: 'low',
          hasPriorStepCommand: false,
          stepCommandPending: false,
        }),
      },
    );

    const plan = steppedPlan({
      reportedStepId: undefined,
      selectedStepId: 'low',
      desiredStepId: 'low',
    });
    expect(executor.hasStablePlanActuation(plan)).toBe(false);
    await expect(executor.applyPlanActions(plan)).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 0,
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
  });

  // Regression: prod 2026-06-03 — a Høiax water heater (binaryCapabilityId 'onoff')
  // deferred to its cheap window, the step was written, but the onoff read came back
  // non-boolean so `binaryControlObservation` was absent and `currentOn` defaulted to
  // the optimistic `true`. The plan kept the device (assumed on) while the executor
  // never issued the binary-on, leaving it at 0 kW with status on_track.
  it('does not re-issue a binary-on for a kept stepped load already observed on', async () => {
    const { executor, deviceManager } = buildExecutor(
      undefined,
      steppedSnapshot({
        binaryControl: { on: true },
        selectedStepId: 'max',
        reportedStepId: 'max',
        binaryControlObservation: onoffObservation(true),
      }),
    );

    await executor.applyPlanActions(steppedPlan({ selectedStepId: 'max', desiredStepId: 'max' }));

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('still restores a kept stepped load observed off (trusted off evidence)', async () => {
    const { executor, deviceManager } = buildExecutor(
      undefined,
      steppedSnapshot({
        binaryControl: { on: false },
        selectedStepId: 'max',
        reportedStepId: 'max',
        binaryControlObservation: onoffObservation(false),
      }),
    );

    await executor.applyPlanActions(steppedPlan({ selectedStepId: 'max', desiredStepId: 'max' }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('passes the producer-resolved per-step installation current for stepped-load flow commands', async () => {
    const { executor, desiredSteppedTrigger } = buildExecutor();

    // The producer (EV target-power profile builder) stamps `planningCurrentA`
    // onto each step; the executor reads it off the desired step instead of
    // re-deriving it from the target-power preset config.
    await expect(executor.applyPlanActions(steppedPlan({
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
          { id: 'low', planningPowerW: 1250, planningCurrentA: 1250 / 230 },
          { id: 'max', planningPowerW: 3000, planningCurrentA: 3000 / 230 },
        ],
      },
    }))).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 1,
      commandRequestCount: 1,
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
      step_id: 'max',
      planning_power_w: 3000,
      planning_current_a: 3000 / 230,
      previous_step_id: 'low',
    }, {
      deviceId: 'dev-1',
    });
  });

  it('emits zero installation current when the step carries no planningCurrentA', async () => {
    const { executor, desiredSteppedTrigger } = buildExecutor();

    // Capability-built / non-preset profiles carry no per-step current, which is
    // the same zero the old watts-per-amp path produced for a missing preset.
    await expect(executor.applyPlanActions(steppedPlan())).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 1,
      commandRequestCount: 1,
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
      step_id: 'max',
      planning_power_w: 3000,
      planning_current_a: 0,
      previous_step_id: 'low',
    }, {
      deviceId: 'dev-1',
    });
  });

  it('projects target updates after awaited stepped-load work in the same cycle', async () => {
    const snapshot = [{
      id: 'dev-1',
      expectedPowerKw: 1,
      name: 'Tank',
      binaryCapabilityId: 'onoff' as const,
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
      binaryControlObservation: onoffObservation(true),
    }];
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(
      undefined,
      snapshot,
      { getSteppedLoadCommandSession: () => ({ hasPriorStepCommand: true, stepCommandPending: false }) },
    );
    desiredSteppedTrigger.trigger.mockImplementation(async () => {
      Object.assign(snapshot[0], {
        targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      });
      return true;
    });

    await expect(executor.applyPlanActions(steppedPlan({
      currentTarget: 18,
      currentTemperature: 18,
      plannedTarget: 23,
    }))).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 1,
      commandRequestCount: 1,
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalled();
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
  });

  it('counts native stepped-load commands as command requests without concrete device writes', async () => {
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, [{
      id: 'dev-1',
      name: 'Tank',
      binaryCapabilityId: 'onoff',
      canSetControl: true,
      available: true,
      binaryControl: { on: true },
      binaryControlObservation: onoffObservation(true),
    }], {
      getSteppedLoadCommandSession: () => ({ hasPriorStepCommand: true, stepCommandPending: false }),
    });
    observeNativeSteppedLoadCommandAdapter({
      owner: deviceManager,
      deviceId: 'dev-1',
      device: {
        id: 'dev-1',
        name: 'Tank',
        ownerUri: 'homey:app:no.hoiax',
        binaryCapabilityId: 'onoff',
        capabilities: ['onoff', 'max_power_3000'],
        capabilitiesObj: {
          onoff: { value: true },
          max_power_3000: { value: '1' },
        },
      } as any,
      clearWhenUnavailable: true,
    });

    await expect(executor.applyPlanActions(steppedPlan({
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: false,
        activationEnabled: true,
      },
    }))).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 1,
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'max_power_3000', '3');
    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_requested',
      commandTransport: 'native_capability',
      desiredStepId: 'max',
    }));
  });

  it('marks stable keep step-up intent as actuatable while the selected step remains lower', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(steppedPlan())).toBe(true);
  });

  it('marks stable keep step-down intent as actuatable while the selected step remains higher', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(steppedPlan({
      selectedStepId: 'max',
      desiredStepId: 'low',
    }))).toBe(true);
  });

  it('marks stable keep step-down intent as actuatable even when restore is not admitted', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(steppedPlan({
      selectedStepId: 'max',
      desiredStepId: 'low',
      reason: { code: PLAN_REASON_CODES.meterSettling, remainingSec: 30 },
    }))).toBe(true);
  });

  it('does not mark off stepped keep step-down intent actuatable during restore hold', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(steppedPlan({
      currentState: 'off',
      selectedStepId: 'max',
      desiredStepId: 'low',
      reason: { code: PLAN_REASON_CODES.meterSettling, remainingSec: 30 },
    }))).toBe(false);
  });

  it('does not mark stable stepped step-up intent actuatable when restore is not admitted', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(steppedPlan({
      reason: { code: PLAN_REASON_CODES.meterSettling, remainingSec: 30 },
    }))).toBe(false);
  });

  it('does not mark stable stepped step-up intent actuatable while the same command is pending', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(steppedPlan({
      lastDesiredStepId: 'max',
      lastStepCommandIssuedAt: Date.now() - 1_000,
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    }))).toBe(false);
  });

  it('does not mark stable stepped step-up intent actuatable during retry backoff', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(steppedPlan({
      lastDesiredStepId: 'max',
      stepCommandPending: false,
      stepCommandStatus: 'stale',
      nextStepCommandRetryAtMs: Date.now() + 30_000,
    }))).toBe(false);
  });

  // Prod incident 2026-07-25: a flow-backed EV charger sat off for 6+ minutes with
  // its target step already confirmed at the lowest active step. Phase 1 of
  // restore-from-off (prepare the step) ran on the cycle the plan action signature
  // changed; phase 2 (write the binary on) needed a LATER cycle, but by then the
  // signature was identical (`keep` / same desiredStepId — the signature carries no
  // observed state) and `hasStableSteppedLoadStepActuation` returns false once the
  // step axis has nothing left to do. So the plan-apply gate never invoked the
  // executor and the binary-on was never issued.
  const preparedRestoreFromOffPlan = (overrides: Record<string, unknown> = {}): DevicePlan => steppedPlan({
    currentState: 'off',
    plannedState: 'keep',
    boostActive: false,
    selectedStepId: 'low',
    reportedStepId: 'low',
    desiredStepId: 'low',
    reason: {
      code: PLAN_REASON_CODES.restoreNeed,
      fromTarget: 'off',
      toTarget: 'low',
      needKw: 1.5,
      headroomKw: null,
    },
    ...overrides,
  });

  it('marks a prepared stepped restore-from-off actuatable so the binary-on still fires', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(preparedRestoreFromOffPlan())).toBe(true);
  });

  it('marks a prepared stepped restore-from-off actuatable under a plain keep reason', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(preparedRestoreFromOffPlan({
      reason: KEEP_REASON,
    }))).toBe(true);
  });

  it('does not mark a stepped restore-from-off actuatable before the step is reported', () => {
    // Phase 1 has been commanded but the device has not reported the step back:
    // the transition is still `step_preparation`, and the signature change that
    // issued the step command is what drives that cycle.
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(preparedRestoreFromOffPlan({
      reportedStepId: undefined,
    }))).toBe(false);
  });

  it('does not mark a prepared stepped restore-from-off actuatable once the device reads on', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(preparedRestoreFromOffPlan({
      currentState: 'on',
    }))).toBe(false);
  });

  it('does not mark a prepared stepped restore-from-off actuatable during a restore hold', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(preparedRestoreFromOffPlan({
      reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 120 },
    }))).toBe(false);
  });

  it('does not mark a prepared stepped restore-from-off actuatable while a binary command is pending', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(preparedRestoreFromOffPlan({
      binaryCommandPending: true,
    }))).toBe(false);
  });

  it('marks a prepared stepped restore-from-off actuatable for an EV charger regrouped like production', () => {
    // The motivating device is an EV charger, and the plan device carries no
    // `evChargingState` at all, so `isCommandableNow(dev)` is always false here
    // (TODO.md P1). Guard that this gate never starts depending on it again.
    const { executor } = buildExecutor();
    const plan = preparedRestoreFromOffPlan({
      deviceClass: 'evcharger',
      objectiveKind: 'ev_soc',
      commandableNow: true,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      confirmedNotDrawing: false,
    });
    const evPlan: DevicePlan = { ...plan, devices: [plan.devices[0]!] };

    // The plug-state rides on the EV cluster now — it is the single source every
    // commandability question is answered from, so the plan device carries it
    // instead of a fan of derived bits.
    expect(evPlan.devices[0]).not.toHaveProperty('evChargingState');
    expect(evPlan.devices[0]).toHaveProperty('objectiveKind', 'ev_soc');
    expect(executor.hasStablePlanActuation(evPlan)).toBe(true);
  });

  it('still marks a prepared stepped restore-from-off actuatable right after the step preparation', () => {
    // The step-preparation command stamps `lastDeviceRestoreMs` too, so an age
    // check on that field would delay the binary-on by a full cooldown and miss
    // the window: observed live 2026-07-25 20:04, where the plan left
    // `restore_need` for `shed` 12 s after the step was confirmed. The bound on
    // repeat attempts comes from the reason allow-set instead — see the
    // `cooldown_restore` case above.
    const { executor, state } = buildExecutor();
    state.lastDeviceRestoreMs['dev-1'] = Date.now() - 1_000;

    expect(executor.hasStablePlanActuation(preparedRestoreFromOffPlan())).toBe(true);
  });

  const evDeadlinePlan = (
    overrides: Partial<DevicePlanDevice>
      & BinaryControlDiscriminantProbe
      & {
        currentTarget?: number;
        evChargingState?: string;
        binaryCapabilityId?: string;
      } = {},
  ): DevicePlan => ({
    meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
    devices: [pd({
      id: 'ev-1',
      name: 'EV Charger',
      // `currentOn` is derived from `binaryControl` per-case (paused default = off,
      // charging override = on); a hardcoded `currentState: 'on'` would contradict
      // the paused default's off-state now that consumers read `currentOn`.
      plannedState: 'keep',
      boostActive: false,
      controllable: true,
      reason: KEEP_REASON,
      deviceClass: 'evcharger',
      binaryCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_paused',
      binaryControl: { on: false },
      deferredReleaseIntent: 'binary_restore',
      ...overrides,
    })],
  });

  it('marks stable EV deadline resume actuatable while the charger remains paused', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(evDeadlinePlan())).toBe(true);
  });

  it('marks stable EV deadline pause actuatable while the charger remains charging', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(evDeadlinePlan({
      evChargingState: 'plugged_in_charging',
      binaryControl: { on: true },
      deferredReleaseIntent: 'binary_release',
    }))).toBe(true);
  });

  it('does not mark stable EV deadline actuation while a binary command is pending', () => {
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(evDeadlinePlan({
      binaryCommandPending: true,
    }))).toBe(false);
  });

  it('does not mark an unplugged charger stable for a deadline resume', () => {
    // Pins the newly-live half of `hasStableBinaryReleaseActuation`: it reads the
    // producer-resolved `commandableNow` off the plan device. Before that bit was
    // carried across `planDevicesBase`, the predicate re-derived from a stripped
    // `evChargingState`, resolved every EV to "state unknown", and was therefore
    // dead in production — so the positive case above passed for the wrong reason
    // and this negative case could not fail. `plugged_out` is one of the two
    // states that genuinely blocks actuation, so it must read false here.
    const { executor } = buildExecutor();

    expect(executor.hasStablePlanActuation(evDeadlinePlan({
      evChargingState: 'plugged_out',
    }))).toBe(false);
  });

  it('does not wait for stepped-load flow execution before completing apply', async () => {
    const { executor, desiredSteppedTrigger, state, deps } = buildExecutor(
      undefined,
      steppedSnapshot(),
    );
    desiredSteppedTrigger.trigger.mockImplementation(() => new Promise<void>(() => {}));

    const outcome = await Promise.race([
      executor.applyPlanActions(steppedPlan()).then(() => 'resolved'),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 0);
      }),
    ]);

    expect(outcome).toBe('resolved');
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
      step_id: 'max',
      planning_power_w: 3000,
      planning_current_a: 0,
      previous_step_id: 'low',
    }, {
      deviceId: 'dev-1',
    });
    expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: expect.any(Number),
      pendingWindowMs: expect.any(Number),
    });
    expect(state.lastRestoreMs).toEqual(expect.any(Number));
  });

  it('does not re-trigger a stepped-load command while the same desired step is pending', async () => {
    const { executor, desiredSteppedTrigger, deps } = buildExecutor(
      undefined,
      steppedSnapshot({
        binaryControlObservation: onoffObservation(true),
      }),
    );

    await executor.applyPlanActions(steppedPlan({
      lastDesiredStepId: 'max',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
  });

  it('does not re-trigger a stale stepped-load command before its retry backoff elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));

    try {
      const now = Date.now();
      const { executor, desiredSteppedTrigger, deps } = buildExecutor(
        undefined,
        steppedSnapshot({
          binaryControl: { on: true },
          binaryControlObservation: onoffObservation(true),
        }),
      );

      await executor.applyPlanActions(steppedPlan({
        lastDesiredStepId: 'max',
        stepCommandPending: false,
        stepCommandStatus: 'stale',
        lastStepCommandIssuedAt: now - 10_000,
        stepCommandRetryCount: 0,
        nextStepCommandRetryAtMs: now + 20_000,
      }));

      expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
      expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a stale stepped-load command after its retry backoff elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));

    try {
      const now = Date.now();
      const { executor, desiredSteppedTrigger, deps } = buildExecutor();

      await executor.applyPlanActions(steppedPlan({
        lastDesiredStepId: 'max',
        stepCommandPending: false,
        stepCommandStatus: 'stale',
        lastStepCommandIssuedAt: now - 40_000,
        stepCommandRetryCount: 0,
        nextStepCommandRetryAtMs: now - 1,
      }));

      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
        step_id: 'max',
        planning_power_w: 3000,
        planning_current_a: 0,
        previous_step_id: 'low',
      }, {
        deviceId: 'dev-1',
      });
      expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        desiredStepId: 'max',
        previousStepId: 'low',
        issuedAtMs: expect.any(Number),
        pendingWindowMs: expect.any(Number),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a stale stepped-load command when the device sits below the desired step and last desired matches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T11:00:00.000Z'));

    try {
      const now = Date.now();
      const { executor, desiredSteppedTrigger, deps } = buildExecutor();

      await executor.applyPlanActions(steppedPlan({
        selectedStepId: 'low',
        lastDesiredStepId: 'max',
        stepCommandPending: false,
        stepCommandStatus: 'stale',
        lastStepCommandIssuedAt: now - 40_000,
        stepCommandRetryCount: 0,
        nextStepCommandRetryAtMs: now - 1,
      }));

      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith({
        step_id: 'max',
        planning_power_w: 3000,
        planning_current_a: 0,
        previous_step_id: 'low',
      }, {
        deviceId: 'dev-1',
      });
      expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        desiredStepId: 'max',
        previousStepId: 'low',
        issuedAtMs: expect.any(Number),
        pendingWindowMs: expect.any(Number),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a stepped device to on when it has keep intent but currentOn is false', async () => {
    const snapshot = steppedSnapshot({
      binaryControl: { on: false },
      selectedStepId: 'low',
      reportedStepId: 'low',
    });
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      reportedStepId: 'low',
      desiredStepId: 'low', // no step change needed
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_succeeded',
      msg: expect.stringContaining('turning on Tank'),
    }));
  });

  it('does not restore a stepped device when planned state is shed', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    // Raw snapshot has currentOn=false, so setBinaryControl skips both shed-off
    // and restore — no binary command issued
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not issue a step-UP command for a shed device with a non-zero desiredStepId', async () => {
    // Regression: applySteppedLoadCommand must never restore a shed device.
    // Poisoned state: shed device has desiredStepId='low' (stale from an interrupted
    // step-down sequence) while selectedStepId has already reached 'off'.
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low', // intentionally illegal: shed + upward step target
    }));

    // Step trigger must not fire — that would be a restore, not a shed
    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    // Binary restore must not be issued either
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it.each([
    { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 30 },
    { code: PLAN_REASON_CODES.meterSettling, remainingSec: 30 },
  ] as const)('does not issue stepped shed preparation for restore-admission hold reason $code', async (reason) => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager, deps } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'max',
      desiredStepId: 'off',
      shedAction: 'turn_off',
      reason,
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it.each([
    { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30 },
    { code: PLAN_REASON_CODES.startupStabilization },
  ] as const)('does not issue stepped shed preparation for already-off shed-window hold reason $code', async (reason) => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager, deps } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'max',
      desiredStepId: 'off',
      shedAction: 'turn_off',
      reason,
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deps.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it.each([
    { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30 },
    { code: PLAN_REASON_CODES.startupStabilization },
  ] as const)('still enforces shed actuation for on stepped devices during hold reason $code', async (reason) => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager, deps } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'max',
      desiredStepId: 'off',
      shedAction: 'turn_off',
      reason,
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deps.markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'dev-1',
      desiredStepId: 'low',
      previousStepId: 'max',
    }));
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it.each([
    { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30 },
    { code: PLAN_REASON_CODES.startupStabilization },
  ] as const)('uses live snapshot to enforce shed actuation during hold reason $code', async (reason) => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'max',
      desiredStepId: 'off',
      shedAction: 'turn_off',
      reason,
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it('keep-invariant enforcement does not restore a shed stepped device even when desiredStepId is non-zero', async () => {
    // Regression: applySteppedLoadRestore checks plannedState === 'keep' and must
    // not fire for a shed device even if desiredStepId points to a non-off step.
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const structuredLog = { info: vi.fn(), debug: vi.fn() };
    const { executor, deviceManager } = buildExecutor(undefined, snapshot, { structuredLog });

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low', // restore-related field; must not trigger invariant restore
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(structuredLog.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stepped_load_binary_transition_applied' }),
    );
  });

  it('does not restore a stepped device when it is already on', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        binaryControlObservation: onoffObservation(true),
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'low',
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not actuate stepped restore work while meter settling holds an off keep device', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      selectedStepId: 'off',
      desiredStepId: 'low',
      targetStepId: 'low',
      reason: fixtureDeviceReason('meter settling (30s remaining)'),
    }));

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('distinguishes turn_off skip reasons when no control path exists', async () => {
    const noTargetsSnapshot = [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Tank',
        available: true,
        binaryControl: { on: true },
      },
    ];
    const noTargetsDebugStructured = vi.fn();
    const noTargets = buildExecutor(undefined, noTargetsSnapshot, { debugStructured: noTargetsDebugStructured });
    await noTargets.executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_failed',
      reasonCode: 'control_request_failed',
      deviceId: 'dev-1',
      deviceName: 'Tank',
      desired: false,
      logContext: 'capacity',
    }));

    const missingCapabilitySnapshot = [
      {
        id: 'dev-1',
        expectedPowerKw: 1,
        name: 'Heater',
        available: true,
        binaryControl: { on: true },
        targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      },
    ];
    const missingCapabilityDebugStructured = vi.fn();
    const missingCapability = buildExecutor(undefined, missingCapabilitySnapshot, { debugStructured: missingCapabilityDebugStructured });
    await missingCapability.executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'binary_command_failed',
      reasonCode: 'control_request_failed',
      deviceId: 'dev-1',
      deviceName: 'Tank',
      desired: false,
      logContext: 'capacity',
    }));
  });

  it('turns on before reasserting the restore step for a stepped device at its off-step', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low', // step change will be issued
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    // The desired step is reasserted immediately after activation.
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(
      deviceManager.setCapability.mock.invocationCallOrder[0],
    ).toBeLessThan(desiredSteppedTrigger.trigger.mock.invocationCallOrder[0]!);
  });

  it('reasserts the lowest restore step after turning on a stepped device with a stale higher step', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'max',
      desiredStepId: 'max',
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('leaves a stepped device on when its post-activation step command cannot be issued', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);
    deviceManager.requestSteppedLoadStep.mockResolvedValueOnce({ requested: false });

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'max',
      desiredStepId: 'max',
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_skipped',
      reasonCode: 'command_unavailable',
      desiredStepId: 'low',
      deviceId: 'dev-1',
      deviceName: 'Tank',
    }));
  });

  it('turns on and reasserts the step despite an earlier pending step command', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'max',
      desiredStepId: 'max',
      lastDesiredStepId: 'low',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
  });

  it('turns on and reasserts the step despite an earlier step retry backoff', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const now = Date.now();
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'max',
      desiredStepId: 'max',
      lastDesiredStepId: 'low',
      stepCommandPending: false,
      stepCommandStatus: 'stale',
      nextStepCommandRetryAtMs: now + 30_000,
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
  });

  it('sets onoff=false for a shed stepped device at its off-step', async () => {
    // The plan sees currentState='off' (from decorated snapshot), but the raw
    // snapshot still has currentOn=true (the onoff capability hasn't been set
    // to false yet). setBinaryControl operates on raw snapshots, so it sees
    // the true value and issues the command.
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, deviceManager, state } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    expect(state.pendingBinaryCommands['dev-1']).toMatchObject({ desired: false });
    expect(logCapture.findEvent('binary_command_applied')).toBeUndefined();
  });

  it('prepares a turn_off stepped shed at the lowest non-zero step before binary off', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager, state, deps } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      shedAction: 'turn_off',
      selectedStepId: 'max',
      desiredStepId: 'off',
      // The planner took this shed all the way to the floor, so the decided end
      // state IS the binary axis and the two-phase descent is what it asks for.
      plannedShedStepId: 'off',
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_requested',
      desiredStepId: 'low',
      plannedDesiredStepId: 'off',
      commandPurpose: 'step_preparation',
      stepPreparationPurpose: 'prepare_for_off',
      effectiveTransition: 'full_shed_to_off',
      binaryTarget: false,
    }));
    expect(state.pendingBinaryCommands['dev-1']).toMatchObject({ desired: false });
    expect(logCapture.findEvent('binary_command_applied')).toBeUndefined();
    expect(state.lastDeviceShedMs['dev-1']).toBeUndefined();
    expect(state.lastDeviceControlledMs['dev-1']).toBeUndefined();
    expect((deps.homey.settings.set as any)).not.toHaveBeenCalledWith(
      DEVICE_LAST_CONTROLLED_MS,
      expect.objectContaining({ 'dev-1': expect.any(Number) }),
    );
  });

  it('leaves a turn_off stepped shed running when the planner parked it at an intermediate rung', async () => {
    // The sibling of the two-phase test above, and the whole point of the shed
    // behaviour being a FLOOR: same `turn_off` device, same ladder, but this
    // cycle decided `low` — the rung its relief was priced at. The step write is
    // the whole actuation; reaching for the binary handle here would cut the
    // load the rung was chosen to keep running.
    const state = createPlanEngineState();
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(state, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      shedAction: 'turn_off',
      reportedStepId: 'max',
      selectedStepId: 'max',
      desiredStepId: 'low',
      plannedShedStepId: 'low',
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_requested',
      effectiveTransition: 'step_down_while_on',
      desiredStepId: 'low',
      previousStepId: 'max',
    }));
    // No step-preparation phase, so nothing claims a binary transition is coming.
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_requested',
      effectiveTransition: 'full_shed_to_off',
    }));
    expect(state.pendingBinaryCommands['dev-1']).toBeUndefined();
  });

  it('records shed actuation when a stepped device sheds by stepping down while remaining on', async () => {
    const state = createPlanEngineState();
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(state, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      shedAction: 'set_step',
      reportedStepId: 'max',
      selectedStepId: 'max',
      desiredStepId: 'low',
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(state.lastDeviceShedMs['dev-1']).toEqual(expect.any(Number));
    expect(state.lastDeviceRestoreMs['dev-1']).toBeUndefined();
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_requested',
      effectiveTransition: 'step_down_while_on',
      desiredStepId: 'low',
      previousStepId: 'max',
    }));
  });

  it('records restore actuation when a plan-mode restore starts by moving from off-step to low', async () => {
    const state = createPlanEngineState();
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
        controlModel: 'stepped_load' as const,
        steppedLoadProfile: steppedProfile,
        reportedStepId: 'off',
      },
    ];
    const { executor, deps } = buildExecutor(state, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'max',
    }));

    expect(state.lastDeviceRestoreMs['dev-1']).toEqual(expect.any(Number));
    expect(state.lastDeviceControlledMs['dev-1']).toEqual(expect.any(Number));
    expect((deps.homey.settings.set as any)).toHaveBeenCalledWith(
      DEVICE_LAST_CONTROLLED_MS,
      expect.objectContaining({ 'dev-1': expect.any(Number) }),
    );
    expect(state.activationAttemptByDevice['dev-1']).toEqual(expect.objectContaining({
      source: 'pels_restore',
      startedMs: expect.any(Number),
    }));
  });

  it('batches last-controlled persistence to one settings write per plan application', async () => {
    const state = createPlanEngineState();
    const snapshot = [
      {
        id: 'dev-restore',
        name: 'Restore Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
      {
        id: 'dev-shed',
        name: 'Shed Heater',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, deps } = buildExecutor(state, snapshot);

    await executor.applyPlanActions({
      meta: buildPlanMeta({
        totalKw: 2,
        softLimitKw: 5,
        headroomKw: 3}),
      devices: [
        pd({
          id: 'dev-restore',
          name: 'Restore Heater',
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: true,
        }),
        pd({
          id: 'dev-shed',
          name: 'Shed Heater',
          currentState: 'on',
          plannedState: 'shed',
          boostActive: false,
          currentTarget: 21,
          currentTemperature: 21,
          plannedTarget: 21,
          controllable: true,
        }),
      ],
    });

    const settingsCalls = (deps.homey.settings.set as any).mock.calls
      .filter(([key]: [string]) => key === DEVICE_LAST_CONTROLLED_MS);
    expect(settingsCalls.length).toBeLessThanOrEqual(1);
    if (settingsCalls[0]) {
      expect(settingsCalls[0][1]).toEqual(expect.objectContaining({
        'dev-restore': expect.any(Number),
        'dev-shed': expect.any(Number),
      }));
    }
  });

  it('does not set onoff=false for a shed stepped device the plan parked at a step', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'low',
      // The decision, not the policy: the plan parks this device at `low`. A
      // `turn_off` behaviour is only the floor, so the binary axis is not this
      // device's end state and must stay untouched.
      plannedShedStepId: 'low',
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });

  it('does not set onoff=false for a keep stepped device at off-step', async () => {
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: true },
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low',
    }));

    // setCapability should not be called with false — only step trigger fires
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it('skips onoff=false when raw snapshot already shows device off', async () => {
    // When the raw onoff capability is already false, setBinaryControl detects
    // the device is already in the desired state and skips the command.
    const snapshot = [
      {
        id: 'dev-1',
        name: 'Tank',
        binaryCapabilityId: 'onoff',
        canSetControl: true,
        available: true,
        binaryControl: { on: false },
      },
    ];
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'off',
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalled();
  });
});

describe('PlanExecutor stepped load reconciliation loop', () => {
  const steppedProfile = {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'max', planningPowerW: 3000 },
    ],
  };

  const steppedPlan = (
    overrides: Partial<DevicePlanDevice>
      & SteppedDiscriminantProbe
      & TemperatureDiscriminantProbe
      & {
        binaryCapabilityId?: string;
      } = {},
  ): DevicePlan => ({
    meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
    devices: [pd({
      id: 'dev-1',
      name: 'Tank',
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      controllable: true,
      binaryCapabilityId: 'onoff',
      reason: KEEP_REASON,
      steppedLoadProfile: steppedProfile,
      reportedStepId: 'low',
      selectedStepId: 'low',
      desiredStepId: 'low',
      ...overrides,
    })],
  });

  const buildLiveDevices = (
    overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe & SteppedDiscriminantProbe
      & { binaryCapabilityId?: string } = {},
  ): PlanInputDevice[] => {
    const merged = {
      id: 'dev-1',
      expectedPowerKw: 1,
      name: 'Tank',
      targets: [],
      steppedLoadProfile: steppedProfile,
      binaryCapabilityId: 'onoff' as const,
      ...overrides,
    };
    return [
      withBinaryDiscriminant(withSteppedDiscriminant(withFixtureResidualKw({
        ...merged,
        currentOn: resolveFixtureCurrentOn(merged),
      }))) as PlanInputDevice,
    ];
  };

  const buildSnapshot = (
    // `selectedStepId` is a plan-device field, not an observed-snapshot field
    // (the snapshot carries `reportedStepId`); accepted on the loose override so
    // call sites can mirror the plan's selected step, then spread inertly.
    overrides: Partial<
      TransportDeviceSnapshot & EvObservedProbe
      & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
    > & { selectedStepId?: string } = { binaryControl: { on: false } },
  ): (TransportDeviceSnapshot & EvObservedProbe & SteppedLoadDescriptorProbe)[] => {
    const { selectedStepId: _selectedStepId, ...snapshotOverrides } = overrides;
    return [{
      id: 'dev-1',
      expectedPowerKw: 1, expectedPowerSource: 'default',
      name: 'Tank',
      binaryCapabilityId: 'onoff' as const,
      canSetControl: true,
      available: true,
      binaryControl: { on: false },
      targets: [],
      controlModel: 'stepped_load' as const,
      steppedLoadProfile: steppedProfile,
      ...snapshotOverrides,
    }];
  };

  it('detects onoff drift and restores a keep device turned off externally', async () => {
    const appliedPlan = steppedPlan({ currentState: 'on', selectedStepId: 'low', desiredStepId: 'low' });
    const liveDevices = buildLiveDevices({
      binaryControl: { on: false },
      selectedStepId: 'low',
      reportedStepId: 'low',
    });

    const livePlan = buildLiveStatePlan(appliedPlan, liveDevices, noPendingBinary);
    expect(hasLiveStateDivergedFromSnapshot(appliedPlan, livePlan)).toBe(true);
    expect(livePlan.devices[0].currentState).toBe('off');

    const { executor, deviceManager } = buildExecutor(undefined, buildSnapshot({
      binaryControl: { on: false },
      selectedStepId: 'low',
      reportedStepId: 'low',
    }));
    await executor.applyPlanActions(livePlan);

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('restores then reasserts the desired step when live state only has fallback evidence', async () => {
    const appliedPlan = steppedPlan({
      currentState: 'on',
      selectedStepId: 'low',
      reportedStepId: 'low',
      desiredStepId: 'low',
    });
    const liveDevices = buildLiveDevices({
      binaryControl: { on: false },
      // Fallback-only live state: no reported step, selectedStepId is the
      // planning fallback.
      selectedStepId: 'low',
    });

    const livePlan = buildLiveStatePlan(appliedPlan, liveDevices, noPendingBinary);
    expect(livePlan.devices[0]).toEqual(expect.objectContaining({
      reportedStepId: undefined,
      selectedStepId: 'low',
    }));

    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(
      undefined,
      buildSnapshot({ binaryControl: { on: false } }),
    );
    await executor.applyPlanActions(livePlan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('detects step drift and re-issues step command for a keep device at off-step', async () => {
    const appliedPlan = steppedPlan({ currentState: 'on', selectedStepId: 'low', desiredStepId: 'low' });
    const liveDevices = buildLiveDevices({ binaryControl: { on: false }, selectedStepId: 'off' });

    const livePlan = buildLiveStatePlan(appliedPlan, liveDevices, noPendingBinary);
    expect(hasLiveStateDivergedFromSnapshot(appliedPlan, livePlan)).toBe(true);

    const { executor, desiredSteppedTrigger } = buildExecutor(undefined, buildSnapshot({ binaryControl: { on: false } }));
    await executor.applyPlanActions(livePlan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_requested',
      deviceId: 'dev-1',
      previousStepId: 'off',
      desiredStepId: 'low',
      plannedDesiredStepId: 'low',
      commandPurpose: 'post_activation_step',
      stepPreparationPurpose: null,
      effectiveTransition: 'restore_from_off_at_low',
      binaryTarget: true,
      transitionPhase: 'post_activation',
    }));
  });

  it('does not count a stepped-load trigger request as a concrete device write', async () => {
    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low',
    });
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(
      undefined,
      buildSnapshot({ binaryControl: { on: true }, binaryControlObservation: onoffObservation(true) }),
    );

    await expect(executor.applyPlanActions(plan)).resolves.toEqual(expect.objectContaining({
      deviceWriteCount: 0,
      commandRequestCount: 1,
    }));

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      actuationSuffix: expect.anything(),
    }));
  });

  it('does not use the keep invariant to restore a stepped load rejected for headroom', async () => {
    const snapshot = buildSnapshot({
      binaryControl: { on: false },
      selectedStepId: 'off',
    });
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low',
      reason: {
        code: PLAN_REASON_CODES.insufficientHeadroom,
        needKw: 1.475,
        availableKw: 0.93,
        postReserveMarginKw: -0.79,
        minimumRequiredPostReserveMarginKw: 0.25,
        penaltyExtraKw: null,
        swapReserveKw: null,
        effectiveAvailableKw: null,
      },
    });

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'stepped_load_binary_transition_applied',
      desiredBinaryState: true,
    }));
  });

  it('re-issues step command when keep device has onoff=true but step is at off', async () => {
    // Raw snapshot has currentOn=true (onoff not violated), but selectedStepId='off'
    // with desiredStepId='low' — only stepViolated is true.
    // The decorated snapshot derives currentState='off' from the off-step, which
    // lets applySteppedLoadRestore enter.
    const snapshot = buildSnapshot({
      binaryControl: { on: true },
      binaryControlObservation: onoffObservation(true),
      reportedStepId: 'off',
    });
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low',
    });

    await executor.applyPlanActions(plan);

    // Step command should be issued to move from off -> low
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    // setBinaryControl is called with desired=true, but raw snapshot already
    // has currentOn=true so it detects "already on" and skips the command.
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it('does not log current_state restore skip when a keep device is already on but needs a higher step', async () => {
    const snapshot = buildSnapshot({
      binaryControl: { on: true },
      binaryControlObservation: onoffObservation(true),
      reportedStepId: 'low',
    });
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'max',
    });

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'max', previous_step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'current_state',
      deviceId: 'dev-1',
    }));
  });

  it('treats a matching in-flight stepped restore as pending instead of no keep violation', async () => {
    // Genuinely-on device (trusted onoff observation) with a step command in
    // flight: the step deferral applies and no defensive binary-on is needed.
    const snapshot = buildSnapshot({ binaryControl: { on: true }, binaryControlObservation: onoffObservation(true) });
    const { executor, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'max',
      lastDesiredStepId: 'max',
      lastStepCommandIssuedAt: Date.now() - 1_000,
      stepCommandPending: true,
      stepCommandStatus: 'pending',
    });

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_skipped',
      reasonCode: 'waiting_for_confirmation',
      deviceId: 'dev-1',
    }));
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'waiting_for_confirmation',
      desiredStepId: 'max',
      deviceId: 'dev-1',
    }));
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'no_keep_violation',
      deviceId: 'dev-1',
    }));
    expect(logCapture.events.every((e) => typeof e.msg !== 'string' || !e.msg.includes('violates keep invariant: step='))).toBe(true);
  });

  // Regression for the exact prod shape: the step command is awaiting confirmation
  // (a matching restore attempt exists) AND the onoff observation is unknown. The
  // step-attempt deferral must NOT suppress the defensive binary-on — otherwise the
  // device sits at 0 kW for the whole pending window.
  it('treats a stepped restore retry window as backoff instead of no keep violation', async () => {
    const snapshot = buildSnapshot({ binaryControl: { on: true } });
    const now = Date.now();
    const { executor, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'max',
      lastDesiredStepId: 'max',
      stepCommandPending: false,
      stepCommandStatus: 'stale',
      nextStepCommandRetryAtMs: now + 30_000,
    });

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_skipped',
      reasonCode: 'retry_backoff',
      deviceId: 'dev-1',
    }));
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'retry_backoff',
      deviceId: 'dev-1',
    }));
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'no_keep_violation',
      deviceId: 'dev-1',
    }));
    expect(logCapture.events.every((e) => typeof e.msg !== 'string' || !e.msg.includes('violates keep invariant: step='))).toBe(true);
  });

  it('keeps snapshot gating before re-issuing a step restore for an off-step keep device', async () => {
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(undefined, []);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low',
    });

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).not.toHaveBeenCalled();
    expect(deviceManager.setCapability).not.toHaveBeenCalled();
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'missing_snapshot',
      deviceId: 'dev-1',
    }));
  });

  it('restores binary before reasserting the step when both onoff and step are violated', async () => {
    // Both violations: raw snapshot has currentOn=false AND selectedStepId='off'
    // while desiredStepId='low'. Both onoffViolated and stepViolated should be true.
    const snapshot = buildSnapshot({
      binaryControl: { on: false },
      selectedStepId: 'off',
    });
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'off',
      desiredStepId: 'low',
    });

    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    // Step command follows binary activation in the same cycle.
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    // Both violations should be logged
    expect(logCapture.events.some((e) => typeof e.msg === 'string' && e.msg.includes('violates keep invariant: onoff='))).toBe(true);
    expect(logCapture.events.some((e) => typeof e.msg === 'string' && e.msg.includes('violates keep invariant: step=off (off-step)'))).toBe(true);
  });

  it('restores then re-issues the low-step command when low is only assumed', async () => {
    const snapshot = buildSnapshot({
      binaryControl: { on: false },
      selectedStepId: 'low',
    });
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'low',
    });

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('reasserts selectedStepId after activation when it is only fallback evidence', async () => {
    const snapshot = buildSnapshot({
      binaryControl: { on: false },
      selectedStepId: 'low',
    });
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'low',
    });

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('reasserts even a reported step after activation', async () => {
    const snapshot = buildSnapshot({
      binaryControl: { on: false },
      selectedStepId: 'low',
      reportedStepId: 'low',
    });
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      reportedStepId: 'low',
      desiredStepId: 'low',
    });

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('does not pass planner restore holds into stepped executor logging', async () => {
    const snapshot = buildSnapshot({ binaryControl: { on: true } });
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'on',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'max',
      reason: { code: PLAN_REASON_CODES.meterSettling, remainingSec: 30 },
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_command_skipped',
      reasonCode: 'restore_not_admitted',
    }));
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      blockedByPlanReasonCode: expect.anything(),
    }));
  });

  it('does not apply target updates while a stepped restore is held by planner admission', async () => {
    const snapshot = buildSnapshot({
      binaryControl: { on: true },
      targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
      expectedPowerKw: 1,
    });
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    await executor.applyPlanActions(steppedPlan({
      currentState: 'off',
      plannedState: 'keep',
      boostActive: false,
      selectedStepId: 'low',
      desiredStepId: 'max',
      currentTarget: 18,
      currentTemperature: 18,
      plannedTarget: 23,
      reason: { code: PLAN_REASON_CODES.meterSettling, remainingSec: 30 },
    }));

    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'target_temperature', 23);
  });

  it('detects step drift and re-issues shed step when external actor raises step', async () => {
    const appliedPlan = steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      shedAction: 'set_step',
      releaseShedStepId: 'low',
      selectedStepId: 'low',
      desiredStepId: 'low',
    });
    const liveDevices = buildLiveDevices({
      binaryControl: { on: true },
      reportedStepId: 'max',
      selectedStepId: 'max',
    });

    const livePlan = buildLiveStatePlan(appliedPlan, liveDevices, noPendingBinary);
    expect(hasLiveStateDivergedFromSnapshot(appliedPlan, livePlan)).toBe(true);

    const { executor, desiredSteppedTrigger } = buildExecutor(undefined, buildSnapshot({ binaryControl: { on: true } }));
    await executor.applyPlanActions(livePlan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_command_requested',
      deviceId: 'dev-1',
      previousStepId: 'max',
      desiredStepId: 'low',
      plannedDesiredStepId: 'low',
      commandPurpose: 'step_adjustment',
      stepPreparationPurpose: null,
      effectiveTransition: 'step_down_while_on',
      binaryTarget: null,
    }));
  });

  it('preserves effective shed step during telemetry gaps so down-step is not blocked', async () => {
    const appliedPlan = steppedPlan({
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      shedAction: 'set_step',
      releaseShedStepId: 'low',
      selectedStepId: 'max',
      desiredStepId: 'low',
      reportedStepId: 'max',
      lastDesiredStepId: 'low',
    });
    // The telemetry gap as the producer emits it: no step evidence resolved this
    // cycle, so `resolveSteppedClusterFields` refused the stepped cluster and the
    // live device is non-stepped. The merge preserves the prior plan's cluster.
    const liveDevices = buildLiveDevices({ binaryControl: { on: true }, steppedLoadProfile: undefined });

    const livePlan = buildLiveStatePlan(appliedPlan, liveDevices, noPendingBinary);
    expect(livePlan.devices[0]).toEqual(expect.objectContaining({
      selectedStepId: 'max',
      reportedStepId: undefined,
    }));
    expect(hasLiveStateDivergedFromSnapshot(appliedPlan, livePlan)).toBe(true);

    const { executor, desiredSteppedTrigger } = buildExecutor(undefined, buildSnapshot({ binaryControl: { on: true } }));
    await executor.applyPlanActions(livePlan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      reasonCode: 'step_up_blocked',
    }));
  });

  it('normalizes a shed-constrained keep restore after binary activation', async () => {
    const snapshot = buildSnapshot({ binaryControl: { on: false } });
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const plan: DevicePlan = {
      meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
      devices: [
        pd({
          id: 'shed-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          controllable: true,
          binaryCapabilityId: 'onoff',
          reason: CAPACITY_REASON,
        }),
        pd({
          id: 'dev-1',
          name: 'Tank',
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          controllable: true,
          binaryCapabilityId: 'onoff',
          reason: KEEP_REASON,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'max',
          desiredStepId: 'max',
        }),
      ],
    };

    await executor.applyPlanActions(plan);

    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low', previous_step_id: 'max' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
  });

  it('allows keep-invariant restore at the lowest active step even before step telemetry arrives', async () => {
    const snapshot = buildSnapshot({ binaryControl: { on: false } });
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    const plan: DevicePlan = {
      meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
      devices: [
        pd({
          id: 'shed-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          controllable: true,
          reason: CAPACITY_REASON,
        }),
        pd({
          id: 'dev-1',
          name: 'Tank',
          currentState: 'off',
          plannedState: 'keep',
          boostActive: false,
          controllable: true,
          reason: KEEP_REASON,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'off',
          desiredStepId: 'low', // at lowestNonZeroStep — allowed
        }),
      ],
    };

    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('restores a keep-invariant device before its step is reported', async () => {
    const snapshot = buildSnapshot({ binaryControl: { on: false } });
    const { executor, deviceManager } = buildExecutor(undefined, snapshot);

    const plan = steppedPlan({ currentState: 'off', selectedStepId: 'off', desiredStepId: 'max' });
    await executor.applyPlanActions(plan);

    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
  });

  it('does not emit restore_keep_invariant_shed_blocked for a true off restore while devices remain shed', async () => {
    const snapshot = buildSnapshot({ binaryControl: { on: false } });
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor } = buildExecutor(state, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const plan: DevicePlan = {
      meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
      devices: [
        pd({
          id: 'shed-1', name: 'Heater', currentState: 'off', plannedState: 'shed',
          controllable: true, reason: CAPACITY_REASON,
        }),
        pd({
          id: 'dev-1', name: 'Tank', currentState: 'off', plannedState: 'keep',
          controllable: true, reason: KEEP_REASON,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'off',
          desiredStepId: 'max',
        }),
      ],
    };

    await executor.applyPlanActions(plan);
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
    expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
  });

  it('normalizes stale desired steps to the same lowest restore step while devices remain shed', async () => {
    // Custom profile with off/low/medium/max so we can test desiredStepId transitions
    const multiStepProfile = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1250 },
        { id: 'medium', planningPowerW: 2000 },
        { id: 'max', planningPowerW: 3000 },
      ],
    };
    const snapshot = buildSnapshot({ binaryControl: { on: false } });
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor, desiredSteppedTrigger, deviceManager } = buildExecutor(state, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const shedDevice = withFixtureResidualKw({
      id: 'shed-1', name: 'Heater', currentState: 'off' as const, plannedState: 'shed' as const,
      controllable: true, available: true, reason: CAPACITY_REASON, boostActive: false,
      hasStandingDemand: true,
      confirmedNotDrawing: false,
      binaryCapabilityId: 'onoff' as const, currentOn: false, commandableNow: true,
      currentDrawKw: 0, expectedPowerKw: 1, expectedPowerSource: 'default' as const,
    });
    const steppedDevice = (desiredStepId: string) => (withFixtureResidualKw({
      id: 'dev-1', name: 'Tank', currentState: 'off' as const, plannedState: 'keep' as const,
      controllable: true, available: true, reason: KEEP_REASON, commandableNow: true,
      boostActive: false, hasStandingDemand: true,
      currentDrawKw: 0, expectedPowerKw: 1, expectedPowerSource: 'default' as const,
      controlModel: 'stepped_load' as const,
      binaryCapabilityId: 'onoff' as const, currentOn: false,
      steppedLoadProfile: multiStepProfile,
      selectedStepId: 'off',
      desiredStepId,
    }));

    await executor.applyPlanActions(
      { meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}), devices: [shedDevice, steppedDevice('medium')] },
    );
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));

    desiredSteppedTrigger.trigger.mockClear();
    deviceManager.setCapability.mockClear();
    await executor.applyPlanActions(
      { meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}), devices: [shedDevice, steppedDevice('max')] },
    );
    expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ step_id: 'low' }),
      expect.objectContaining({ deviceId: 'dev-1' }),
    );
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);
  });

  it('keeps shed-block dedupe state clear across admitted off restores', async () => {
    const snapshot = buildSnapshot({ binaryControl: { on: false } });
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor, deviceManager } = buildExecutor(state, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const blockedPlan: DevicePlan = {
      meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
      devices: [
        pd({
          id: 'shed-1', name: 'Heater', currentState: 'off', plannedState: 'shed',
          controllable: true, reason: CAPACITY_REASON,
        }),
        pd({
          id: 'dev-1', name: 'Tank', currentState: 'off', plannedState: 'keep',
          controllable: true, reason: KEEP_REASON,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'max',
          desiredStepId: 'max',
        }),
      ],
    };
    const admittedPlan: DevicePlan = {
      meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
      devices: [
        pd({
          id: 'dev-1', name: 'Tank', currentState: 'off', plannedState: 'keep',
          controllable: true, reason: KEEP_REASON,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'off',
          desiredStepId: 'max',
        }),
      ],
    };

    await executor.applyPlanActions(blockedPlan);
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));

    debugStructured.mockClear();
    deviceManager.setCapability.mockClear();
    await executor.applyPlanActions(admittedPlan);
    expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', false);

    debugStructured.mockClear();
    await executor.applyPlanActions(blockedPlan);
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
    }));
  });

  it('does not block keep restore when a planner-shed stepped device has no executable shed intent', async () => {
    // Bug regression: when a stepped shed device has shedAction='set_step' but no resolvable
    // step (no commandStepId, no plannedStepId), its executable steppedLoad intent is null.
    // The keep-invariant gate must read the executable shed set, not the planner shed set,
    // so this phantom shed does not block unrelated restores.
    const snapshot = buildSnapshot({
      binaryControl: { on: false },
      selectedStepId: 'max',
      reportedStepId: 'max',
    });
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const debugStructured = vi.fn();
    const { executor, deviceManager } = buildExecutor(state, snapshot, {
      structuredLog: structuredLog as any,
      debugStructured,
    });

    const plan: DevicePlan = {
      meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
      devices: [
        pd({
          // Underspecified stepped shed: set_step but no resolvable step.
          // buildExecutableSteppedLoadIntent returns null for this device.
          id: 'shed-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          boostActive: false,
          controllable: true,
          reason: CAPACITY_REASON,
          steppedLoadProfile: steppedProfile,
          shedAction: 'set_step',
          selectedStepId: undefined,
          desiredStepId: undefined,
        }),
        pd({
          // Keep device that drifted off: planner thought it was on at max, snapshot says off.
          // Step is materialized at 'max' in the snapshot, so the binary restore can proceed.
          // Projection produces desired.on=true, desired.stepId='max', so the keep-invariant
          // gate would fire if it consulted the planner shed set rather than the executable
          // shed set.
          id: 'dev-1',
          name: 'Tank',
          currentState: 'on',
          plannedState: 'keep',
          boostActive: false,
          controllable: true,
          reason: KEEP_REASON,
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'max',
          desiredStepId: 'max',
        }),
      ],
    };

    await executor.applyPlanActions(plan);

    // Restore must NOT be gated by the phantom shed-1.
    expect(logCapture.events).not.toContainEqual(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
      deviceId: 'dev-1',
    }));
    expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'restore_keep_invariant_shed_blocked',
      deviceId: 'dev-1',
    }));
    // Binary restore should be issued for dev-1.
    expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    // The dropped underspecified shed intent must be surfaced via structured log,
    // including the actuation mode so plan vs reconcile drops stay distinguishable.
    expect(logCapture.events).toContainEqual(expect.objectContaining({
      event: 'stepped_load_shed_intent_dropped',
      reasonCode: 'underspecified_set_step',
      deviceId: 'shed-1',
    }));
  });

  // -------------------------------------------------------------------------
  // Group 3: stepped-load turn_on (keep) actuation semantics
  // Tests marked it.fails() document desired behavior not yet implemented.
  // -------------------------------------------------------------------------

  describe('turn_on (keep) actuation semantics (Group 3)', () => {
    // Test 3.1: device has a non-zero step but onoff is false. Activation can
    // reset a vendor-side step, so reassert even an already reported value.
    it('sends onoff=true then reasserts an already non-zero step', async () => {
      const snapshot = buildSnapshot({
        binaryControl: { on: false },
        selectedStepId: 'low',
        reportedStepId: 'low',
      });
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        boostActive: false,
        selectedStepId: 'low',
        reportedStepId: 'low',
        desiredStepId: 'low', // non-zero, matches selected — no step change
      }));

      // Binary must be restored
      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
    });

    // Test 3.2: desiredStepId has been pre-normalized to 'low' (lowest non-zero) before
    // the executor runs. With the correct desiredStepId in place, the executor must issue
    // binary ON and then the normalized step command in the same cycle.
    // Note: this passes because desiredStepId is explicitly set to 'low' here.
    // The companion planDevices test (it.fails) covers the normalization gap.
    it('issues step command when desiredStepId is pre-normalized to lowest non-zero and step is at off-step', async () => {
      const snapshot = buildSnapshot({
        binaryControl: { on: false },
        selectedStepId: 'off',
      });
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        boostActive: false,
        selectedStepId: 'off',
        desiredStepId: 'low', // pre-normalized to lowest non-zero
      }));

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      // Step command from off → low
      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
    });

    // Test 3.3: selectedStepId is unknown while binary onoff is false.
    // Restore must re-enter at the lowest non-zero step rather than trusting a stale
    // desiredStepId, so the load becomes deterministic again.
    it('normalizes unknown-step restore after binary activation', async () => {
      const snapshot = buildSnapshot({ binaryControl: { on: false } });
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        boostActive: false,
        selectedStepId: undefined as unknown as string, // unknown
        desiredStepId: 'max', // non-zero intended step
      }));

      // Step command must normalize to the lowest non-zero step.
      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    });

    it('reasserts a known non-zero step after binary activation', async () => {
      const snapshot = buildSnapshot({
        binaryControl: { on: false },
        selectedStepId: 'low',
        reportedStepId: 'low',
      });
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        boostActive: false,
        selectedStepId: 'low',
        reportedStepId: 'low',
        desiredStepId: 'low',
      }));

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
    });

    it('sends binary restore before the normalization step', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          binaryCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          binaryControl: { on: false },
        },
      ];
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        boostActive: false,
        selectedStepId: undefined as unknown as string,
        desiredStepId: 'max',
      }));

      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
    });

    // Test 3.4 / Regression 5.2 (executor layer): when both desiredStepId and selectedStepId
    // are the off-step, the executor must still issue a step command to the lowest non-zero
    // step — it must not leave the device at zero-step after turning binary on.
    // Current: only binary on is sent because desiredStepId='off'=selectedStepId, so
    // applySteppedLoadCommand sees no change and skips.
    it('issues step command to lowest non-zero step when both desiredStepId and selectedStepId are zero-usage', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          binaryCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          binaryControl: { on: false },
        },
      ];
      const { executor, deviceManager, desiredSteppedTrigger } = buildExecutor(undefined, snapshot);

      // Both desiredStepId and selectedStepId are off-step — un-normalized state
      // that planDevices currently produces for a restored device shed to off-step.
      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',
        plannedState: 'keep',
        boostActive: false,
        selectedStepId: 'off',
        desiredStepId: 'off', // un-normalized: should still trigger step command to 'low'
      }));

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', true);
      // A step command to the lowest non-zero step must also be issued
      expect(desiredSteppedTrigger.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ step_id: 'low' }),
        expect.objectContaining({ deviceId: 'dev-1' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Group 2 executor + Regression 5.1: stepped-load turn_off actuation
  // -------------------------------------------------------------------------

  describe('turn_off shed actuation (Group 2 executor / Regression 5.1)', () => {
    it('uses raw snapshot state for binary shed-off when decorated currentState is stale', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          binaryCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          binaryControl: { on: true },
        },
      ];
      const { executor, deviceManager } = buildExecutor(undefined, snapshot);

      await executor.applyPlanActions({
        meta: buildPlanMeta({
          totalKw: 1,
          softLimitKw: 5,
          headroomKw: 4}),
        devices: [
          pd({
            id: 'dev-1',
            name: 'Tank',
            currentState: 'off',
            plannedState: 'shed',
            boostActive: false,
            currentTarget: 21,
            currentTemperature: 21,
            plannedTarget: 21,
            controllable: true,
            binaryCapabilityId: 'onoff',
            reason: CAPACITY_REASON,
          }),
        ],
      });

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    });

    // Test 2.4: binary is already off; the executor must not re-enable it.
    it('does not re-enable binary when device is already off at a non-lowest step', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          binaryCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          binaryControl: { on: false }, // binary already off
        },
      ];
      const { executor, deviceManager } = buildExecutor(undefined, snapshot);

      // Device is shed with turn_off at a non-off step; binary is already off.
      await executor.applyPlanActions(steppedPlan({
        currentState: 'off',  // off because binary is false
        plannedState: 'shed',
        boostActive: false,
        shedAction: 'turn_off',
        selectedStepId: 'low', // not at off-step yet
        desiredStepId: 'off',  // intended lowest
      }));

      // Binary must NOT be re-enabled (no onoff=true)
      expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'onoff', true);
    });

    // Regression 5.1: turn_off shed must send onoff=false immediately, even before the
    // step has reached the off-step. Current: applySteppedLoadShedOff only fires once
    // selectedStepId is already the off-step — binary off is deferred too long.
    it('sends onoff=false immediately, without waiting to reach off-step (Regression 5.1)', async () => {
      const snapshot = [
        {
          id: 'dev-1',
          name: 'Tank',
          binaryCapabilityId: 'onoff',
          canSetControl: true,
          available: true,
          binaryControl: { on: true }, // binary still on
        },
      ];
      const { executor, deviceManager } = buildExecutor(undefined, snapshot);

      // Device is planned to shed with turn_off. It is currently at a non-off step.
      // The contract says onoff=false must be sent as part of the turn_off action,
      // not only after the step has already stepped down to the off-step.
      await executor.applyPlanActions(steppedPlan({
        currentState: 'on',
        plannedState: 'shed',
        boostActive: false,
        shedAction: 'turn_off',
        selectedStepId: 'low', // NOT at off-step
        desiredStepId: 'off',  // intended lowest step (per contract)
      }));

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'onoff', false);
    });
  });

  // The charger re-shed cooldown deadlock (prod 2026-07-26): a held stepped EV
  // charger got a real `evcharger_charging=false` write on every rebuild (the
  // already-matched skip is disabled for chargers), and every write restamped
  // the GLOBAL shed cooldown via `recordShedActuation` — freezing every restore
  // in the house. These pin the two independent halves of the fix at the
  // applyPlanActions level.
  describe('charger shed re-assert (cooldown-freeze P0, prod 2026-07-26)', () => {
    const trustedOffObservation = {
      valid: true as const,
      capabilityId: 'evcharger_charging',
      observedValue: false,
      observedCapabilityIds: ['evcharger_charging'],
      observedAtMs: 1,
      source: 'device_update' as const,
    };
    const chargerSnapshot = (overrides: Record<string, unknown>) => ([{
      id: 'dev-1',
      expectedPowerKw: 1,
      name: 'Elbillader',
      binaryCapabilityId: 'evcharger_charging',
      canSetControl: true,
      available: true,
      controlModel: 'stepped_load' as const,
      steppedLoadProfile: steppedProfile,
      targets: [],
      ...overrides,
    }]);
    const chargerShedPlan = () => steppedPlan({
      name: 'Elbillader',
      currentState: 'off',
      plannedState: 'shed',
      boostActive: false,
      shedAction: 'turn_off',
      binaryCapabilityId: 'evcharger_charging',
      selectedStepId: 'low',
      desiredStepId: 'off',
      reason: CAPACITY_REASON,
    });

    it('skips the off-write when the resolved binary state is already off', async () => {
      const state = createPlanEngineState();
      const { executor, deviceManager } = buildExecutor(state, chargerSnapshot({
        binaryControl: { on: false },
        binaryControlObservation: trustedOffObservation,
      }));

      await executor.applyPlanActions(chargerShedPlan());

      expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'evcharger_charging', false);
      expect(state.lastInstabilityMs).toBeNull();
      expect(state.lastDeviceShedMs['dev-1']).toBeUndefined();
    });

    it('skips off for a paused charger when the binary command axis is already off', async () => {
      const state = createPlanEngineState();
      const { executor, deviceManager } = buildExecutor(state, chargerSnapshot({
        binaryControl: { on: false },
        binaryControlObservation: trustedOffObservation,
      }));

      await executor.applyPlanActions(chargerShedPlan());

      expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'evcharger_charging', false);
      expect(state.lastInstabilityMs).toBeNull();
      expect(state.lastDeviceShedMs['dev-1']).toBeUndefined();
    });

    it('stamps the shed cooldown for a real shed of a charging charger', async () => {
      const state = createPlanEngineState();
      const { executor, deviceManager } = buildExecutor(state, chargerSnapshot({
        binaryControl: { on: true },
        binaryControlObservation: { ...trustedOffObservation, observedValue: true },
      }));

      await executor.applyPlanActions(chargerShedPlan());

      expect(deviceManager.setCapability).toHaveBeenCalledWith('dev-1', 'evcharger_charging', false);
      const pending = state.pendingBinaryCommands['dev-1'];
      syncPendingBinaryCommands({
        store: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        liveDevices: [{
          id: 'dev-1', name: 'Charger',
          binaryCommandConfirmation: {
            state: 'observed', observedValue: false, observedAtMs: pending.startedMs + 1,
          },
        }],
        source: 'device_update',
        onConfirmed: (params) => executor.handleConfirmedBinaryCommand(params),
      });
      expect(typeof state.lastInstabilityMs).toBe('number');
      expect(typeof state.lastDeviceShedMs['dev-1']).toBe('number');
    });

    it('skips off from the resolved binary state even without observation metadata', async () => {
      // Planner inputs are already producer-resolved. Missing observation
      // metadata does not turn a strict `binaryControl.on === false` into an
      // unknown value or justify a redundant write.
      const state = createPlanEngineState();
      const { executor, deviceManager } = buildExecutor(state, chargerSnapshot({
        binaryControl: { on: false },
      }));

      await executor.applyPlanActions(chargerShedPlan());

      expect(deviceManager.setCapability).not.toHaveBeenCalledWith('dev-1', 'evcharger_charging', false);
      expect(state.lastInstabilityMs).toBeNull();
      expect(state.lastDeviceShedMs['dev-1']).toBeUndefined();
    });
  });
});
