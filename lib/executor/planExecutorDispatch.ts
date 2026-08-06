import type { DevicePlan, ShedAction } from '../plan/planTypes';
import type { PlanEngineState } from '../plan/planState';
import {
  shouldSkipShedding,
  shouldSkipUnavailable,
} from '../plan/planExecutorSupport';
import { getLogger } from '../logging/logger';
import type {
  ExecutableBinaryIntent,
  ExecutableObservedDeviceState,
  ExecutablePlan,
  ExecutableReleaseIntent,
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
  ExecutableTargetIntent,
  ExecutableTargetUpdate,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import {
  applyShedTemperaturePlan,
  applyTargetUpdate,
  trySetShedTemperature,
  type PlanExecutorTargetContext,
} from './targetExecutor';
import {
  applySteppedLoadCommand,
  applySteppedLoadRestore,
  applySteppedLoadShedOff,
  type PlanExecutorSteppedContext,
} from './steppedLoadExecutor';
import {
  applyDeferredBinaryCommand,
  applyBinaryRestore,
  applyBinarySheddingToDevice,
  applyUncontrolledBinaryRestore,
  type PlanExecutorBinaryContext,
} from './binaryExecutor';
import { applyShedReleaseIntent } from './shedReleaseActuation';
import {
  buildExecutableObservedDeviceState,
  buildExecutableObservedState,
  buildExecutablePlan,
  findDroppedSteppedShedIntents,
  hasExecutableShedDevices,
} from './executablePlanProjection';
import {
  buildExecutableSteppedLoadDevice,
  resolveSteppedLoadCurrentFallback,
} from './executableSteppedLoadProjection';
import {
  buildExecutableTargetCommand,
  buildExecutableTargetUpdate,
} from './executableTargetProjection';
import { isSteppedLoadRestoreFromOff } from './planExecutorPredicates';
import { isRequestedStepMaterialized } from './steppedLoadActuation';

const logger = getLogger('executor/plan');

export type PlanActuationResult = {
  deviceWriteCount: number;
  commandRequestCount: number;
  /**
   * Ids of the devices this actuation actually touched (a write or a command
   * request). The counts alone are a plan-wide fact; consumers that act per
   * device need to know WHICH — the realtime circuit breaker charges a strike
   * against a device only when that device was the one written.
   */
  writtenDeviceIds: string[];
};

type PlanActionHandleResult = {
  handled: boolean;
  wrote: boolean;
};

/**
 * The capabilities the dispatch free functions need from the owning
 * `PlanExecutor`. Context builders, recorders, and snapshot/state reads stay on
 * the class (they close over `this.deps`/`this.state`); the dispatch layer
 * consumes them through this handle so the actuation-path logic lives in one
 * navigable module without dragging the class along.
 */
export type PlanExecutorCore = {
  buildTargetExecutorContext: () => PlanExecutorTargetContext;
  buildSteppedExecutorContext: () => PlanExecutorSteppedContext;
  buildBinaryExecutorContext: () => PlanExecutorBinaryContext;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  getSteppedLoadCommandSession: (deviceId: string) => {
    initializationAssumedStepId?: string;
    hasPriorStepCommand: boolean;
    reportedStepId?: string;
  };
  recordReleaseShedActuation: (deviceId: string, name: string, now: number) => void;
  latestTargetSnapshot: () => ExecutorDeviceSnapshot[];
  capacityDryRun: () => boolean;
  state: PlanEngineState;
  flushLastControlledPersistence: () => void;
  // Routes through the spyable instance method so `applyPlanActions` → binary shed
  // still hits any test spy on `executor.applySheddingToDevice`.
  applySheddingToDevice: (deviceId: string, deviceName: string, reason?: string) => Promise<boolean>;
};

/**
 * One device's contribution. Deliberately NOT `PlanActuationResult`: that is the
 * plan-wide total and additionally names WHICH devices were touched, which a
 * per-device delta cannot know. Aliasing the two is what let a plan-wide
 * "something was written" answer be attributed to every device in a batch.
 */
type DispatchDelta = {
  deviceWriteCount: number;
  commandRequestCount: number;
};

const delta = (deviceWriteCount: number, commandRequestCount: number): DispatchDelta => ({
  deviceWriteCount,
  commandRequestCount,
});

const ZERO_DELTA: DispatchDelta = { deviceWriteCount: 0, commandRequestCount: 0 };

type DeviceIntentArgs = {
  intent: ExecutablePlan['devices'][number];
  observed: ExecutableObservedDeviceState | undefined;
  snapshot: ExecutorDeviceSnapshot | undefined;
  hasShedDevices: boolean;
  steppedFallback: ReturnType<typeof resolveSteppedLoadCurrentFallback>;
};

type ResolvedDeviceIntent = DeviceIntentArgs & {
  steppedAction: ReturnType<typeof buildExecutableSteppedLoadDevice>;
};

const applyBinaryRestoreIntent = async (
  core: PlanExecutorCore,
  intent: ExecutableBinaryIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => applyBinaryRestore(core.buildBinaryExecutorContext(), intent, observed);

const applyDeferredBinaryIntent = async (
  core: PlanExecutorCore,
  intent: ExecutableReleaseIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => applyDeferredBinaryCommand(core.buildBinaryExecutorContext(), intent, observed);

const dispatchShedReleaseIntent = async (
  core: PlanExecutorCore,
  params: {
    intent: ExecutableReleaseIntent;
    steppedLoadIntent: ExecutableSteppedLoadIntent | null;
    observed: ExecutableObservedDeviceState | undefined;
    snapshot: ExecutorDeviceSnapshot | undefined;
  },
): Promise<boolean> => applyShedReleaseIntent({
  ...params,
  deps: {
    getShedBehavior: core.getShedBehavior,
    buildBinaryExecutorContext: () => core.buildBinaryExecutorContext(),
    buildTargetExecutorContext: () => core.buildTargetExecutorContext(),
    buildSteppedExecutorContext: () => core.buildSteppedExecutorContext(),
    recordReleaseShedActuation: core.recordReleaseShedActuation,
  },
});

const resolveLatestObservedDevice = (
  core: PlanExecutorCore,
  deviceId: string,
  observed: ExecutableObservedDeviceState | undefined,
): ExecutableObservedDeviceState | undefined => {
  const snapshot = core.latestTargetSnapshot().find((entry) => entry.id === deviceId);
  return snapshot ? buildExecutableObservedDeviceState(snapshot) : observed;
};

const buildTargetUpdateAction = (
  core: PlanExecutorCore,
  intent: ExecutableTargetIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
): ExecutableTargetUpdate | null => buildExecutableTargetUpdate(intent, observed, core.getShedBehavior);

const applyShedTemperatureIntent = async (
  core: PlanExecutorCore,
  intent: ExecutableTargetIntent,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  const command = buildExecutableTargetCommand(intent, observed);
  if (core.capacityDryRun()) {
    logger.info({ event: 'executor_plan_log', msg: `Capacity (dry run): would set ${command?.targetCap || 'target'} `
      + `for ${intent.name} to ${intent.desired}°C (shedding)` });
    return false;
  }
  if (!command) return false;
  if (Object.is(command.observedValue, command.desired)) {
    logger.debug({ event: 'executor_plan_log_debug', msg: `Capacity: skip setting ${command.targetCap || 'target'} `
      + `for ${intent.name}, already at ${intent.desired}°C` });
    return false;
  }
  const result = await applyShedTemperaturePlan(core.buildTargetExecutorContext(), command);
  return result.wrote;
};

const applyTargetIntent = async (
  core: PlanExecutorCore,
  intent: ExecutableTargetIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  if (!intent) return false;
  const latestObserved = resolveLatestObservedDevice(core, intent.deviceId, observed);
  if (intent.purpose === 'shed_temperature') {
    return applyShedTemperatureIntent(core, intent, latestObserved);
  }
  return applyTargetUpdate(
    core.buildTargetExecutorContext(),
    buildTargetUpdateAction(core, intent, latestObserved),
  );
};

const applyUncontrolledRestore = async (
  core: PlanExecutorCore,
  intent: ExecutableBinaryIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => applyUncontrolledBinaryRestore(core.buildBinaryExecutorContext(), intent, observed);

const applyBinaryShedIntent = async (
  core: PlanExecutorCore,
  intent: ExecutableBinaryIntent | null,
): Promise<boolean> => {
  if (!intent || intent.kind !== 'shed') return false;
  return core.applySheddingToDevice(intent.deviceId, intent.name, intent.reason);
};

const dispatchSteppedLoadCommand = async (
  core: PlanExecutorCore,
  action: ExecutableSteppedLoadDevice | null,
  snapshot?: ExecutorDeviceSnapshot,
  options: {
    recordPlanActuation?: boolean;
    force?: boolean;
    preserveMaterializedConfirmation?: boolean;
    commandPurpose?: 'post_activation_step';
  } = {},
): Promise<boolean> => (action
  ? applySteppedLoadCommand(core.buildSteppedExecutorContext(), action, snapshot, options)
  : false);

const dispatchSteppedLoadRestore = async (
  core: PlanExecutorCore,
  action: ExecutableSteppedLoadDevice | null,
  params: {
    snapshot: ExecutorDeviceSnapshot | undefined;
    hasShedDevices: boolean;
  },
) => (action
  ? applySteppedLoadRestore(core.buildSteppedExecutorContext(), { action, ...params })
  : { ready: false, wroteBinary: false });

const dispatchSteppedLoadShedOff = async (
  core: PlanExecutorCore,
  action: ExecutableSteppedLoadDevice | null,
  snapshot: ExecutorDeviceSnapshot | undefined,
): Promise<boolean> => (action
  ? applySteppedLoadShedOff(core.buildSteppedExecutorContext(), action, snapshot)
  : false);

const applyUncontrolledDeviceIntent = async (
  core: PlanExecutorCore,
  ctx: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { intent, observed, snapshot, steppedAction } = ctx;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  // Cap-off + deferred release is the lifecycle-end path: the deferred objective
  // was the only reason PELS was driving this device, and it just transitioned out
  // of plannable status. Fire the device's configured release posture and skip the
  // uncontrolled-restore so we don't immediately re-enable what we just released.
  if (intent.release?.kind === 'binary_release') {
    if (await dispatchSteppedLoadCommand(core, steppedAction, snapshot)) commandRequestCount += 1;
    if (await applyDeferredBinaryIntent(core, intent.release, observed)) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  if (intent.release?.kind === 'shed_release') {
    if (await dispatchShedReleaseIntent(core, {
      intent: intent.release,
      steppedLoadIntent: intent.steppedLoad,
      observed,
      snapshot,
    })) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  if (await dispatchSteppedLoadCommand(core, steppedAction, snapshot)) commandRequestCount += 1;
  if (await applyUncontrolledRestore(core, intent.binary, observed)) deviceWriteCount += 1;
  if (await applyTargetIntent(core, intent.target, observed)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applySteppedRestoreFromOffIntent = async (
  core: PlanExecutorCore,
  ctx: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { intent, observed, snapshot, steppedAction, hasShedDevices } = ctx;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  if (steppedAction?.desired.on !== true) {
    if (await applyTargetIntent(core, intent.target, observed)) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  const stepRestore = await dispatchSteppedLoadRestore(core, steppedAction, {
    snapshot,
    hasShedDevices,
  });
  if (
    stepRestore.ready
    && (
      stepRestore.wroteBinary
      || !isRequestedStepMaterialized(steppedAction.commandStepActuation)
    )
    && await dispatchSteppedLoadCommand(core, steppedAction, snapshot, {
      recordPlanActuation: false,
      // The activation cycle must reassert even a matching observed step.
      // Later OFF-echo cycles may reconcile a contradictory report, but keep
      // normal pending/backoff dampening so they cannot churn the same Flow.
      force: stepRestore.wroteBinary,
      preserveMaterializedConfirmation: true,
      commandPurpose: 'post_activation_step',
    })
  ) commandRequestCount += 1;
  if (stepRestore.wroteBinary) deviceWriteCount += 1;
  if (await applyTargetIntent(core, intent.target, observed)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applySteppedShedRestoreIntent = async (
  core: PlanExecutorCore,
  ctx: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { intent, observed, snapshot, steppedAction, hasShedDevices } = ctx;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  if (await dispatchSteppedLoadCommand(core, steppedAction, snapshot)) commandRequestCount += 1;
  if (await dispatchSteppedLoadShedOff(core, steppedAction, snapshot)) deviceWriteCount += 1;
  const restored = await dispatchSteppedLoadRestore(core, steppedAction, { snapshot, hasShedDevices });
  if (restored.wroteBinary) deviceWriteCount += 1;
  if (await applyTargetIntent(core, intent.target, observed)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applyDefaultBinaryIntent = async (
  core: PlanExecutorCore,
  ctx: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { intent, observed } = ctx;
  let deviceWriteCount = 0;
  if (await applyDeferredBinaryIntent(core, intent.release, observed)) {
    return delta(1, 0);
  }
  if (await applyBinaryRestoreIntent(core, intent.binary, observed)) deviceWriteCount += 1;
  if (await applyTargetIntent(core, intent.target, observed)) deviceWriteCount += 1;
  return delta(deviceWriteCount, 0);
};

const applyDeviceIntent = async (
  core: PlanExecutorCore,
  args: DeviceIntentArgs,
): Promise<DispatchDelta> => {
  const { intent } = args;
  if (intent.projectionError) throw intent.projectionError;
  const steppedAction = buildExecutableSteppedLoadDevice(
    intent.steppedLoad,
    args.observed,
    args.steppedFallback,
    core.getSteppedLoadCommandSession(intent.id),
  );
  if (shouldSkipUnavailable({
    snapshot: args.snapshot,
    name: intent.name,
    operation: 'actuation',
  })) {
    return ZERO_DELTA;
  }
  const ctx: ResolvedDeviceIntent = { ...args, steppedAction };
  if (intent.controllable === false) return applyUncontrolledDeviceIntent(core, ctx);
  if (isSteppedLoadRestoreFromOff(intent.steppedLoad, steppedAction)) {
    return applySteppedRestoreFromOffIntent(core, ctx);
  }
  if (intent.steppedLoad) return applySteppedShedRestoreIntent(core, ctx);
  if (intent.target?.purpose === 'shed_temperature') {
    return (await applyTargetIntent(core, intent.target, args.observed))
      ? delta(1, 0)
      : ZERO_DELTA;
  }
  if (intent.binary?.kind === 'shed') {
    return (await applyBinaryShedIntent(core, intent.binary)) ? delta(1, 0) : ZERO_DELTA;
  }
  return applyDefaultBinaryIntent(core, ctx);
};

const logUnderspecifiedSteppedShedDevices = (
  plan: DevicePlan,
  exec: ExecutablePlan,
): void => {
  for (const dropped of findDroppedSteppedShedIntents(plan, exec)) {
    logger.debug({
      event: 'stepped_load_shed_intent_dropped',
      reasonCode: 'underspecified_set_step',
      ...dropped,
    });
  }
};

export const dispatchPlanActions = async (
  core: PlanExecutorCore,
  plan: DevicePlan,
): Promise<PlanActuationResult> => {
  const executablePlan = buildExecutablePlan(plan);
  const observedState = buildExecutableObservedState(core.latestTargetSnapshot());
  const observedMap = new Map(observedState.devices.map((entry) => [entry.id, entry]));
  // Producer-resolved current state per device. The raw dispatch snapshot carries
  // no observed step (`selectedStepId` is a plan-device decoration, absent here),
  // so the effective current step/on is resolved once on the plan device and
  // supplied to the projection — keeping current-state resolution in the producer
  // layer rather than re-derived on the (desired-only) executable intent. The
  // observation stays authoritative for any field it does carry (binary on,
  // reported step, measured power).
  const steppedFallbackMap = new Map(
    plan.devices.map((device) => [device.id, resolveSteppedLoadCurrentFallback(device)]),
  );
  const hasShedDevices = hasExecutableShedDevices(plan, executablePlan);
  logUnderspecifiedSteppedShedDevices(plan, executablePlan);
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  const writtenDeviceIds: string[] = [];
  for (const intent of executablePlan.devices) {
    const observed = observedMap.get(intent.id);
    const snapshot = observed?.snapshot;
    try {
      const result = await applyDeviceIntent(core, {
        intent,
        observed,
        snapshot,
        hasShedDevices,
        steppedFallback: steppedFallbackMap.get(intent.id),
      });
      deviceWriteCount += result.deviceWriteCount;
      commandRequestCount += result.commandRequestCount;
      if (result.deviceWriteCount > 0 || result.commandRequestCount > 0) {
        // eslint-disable-next-line functional/immutable-data -- local accumulator, same shape as the counters above
        writtenDeviceIds.push(intent.id);
      }
    } catch (error) {
      logger.error({
        event: 'executor_plan_error',
        msg: `Failed to apply action for ${intent.name}; continuing with remaining devices`,
        err: error,
      });
    }
  }
  return { deviceWriteCount, commandRequestCount, writtenDeviceIds };
};

export const applySheddingToDeviceImpl = async (
  core: PlanExecutorCore,
  deviceId: string,
  deviceName: string,
  reason?: string,
): Promise<boolean> => {
  try {
    if (core.capacityDryRun()) return false;
    const snapshotState = core.latestTargetSnapshot().find((d) => d.id === deviceId);
    if (shouldSkipShedding({
      state: core.state,
      deviceId,
      deviceName,
      snapshotState,
    })) {
      return false;
    }
    const name = deviceName;
    const shedBehavior = core.getShedBehavior(deviceId);
    const targetCap = snapshotState?.targets?.[0]?.id;
    const shedTemp = shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null
      ? shedBehavior.temperature
      : null;
    const canSetShedTemp = Boolean(targetCap && shedTemp !== null);
    // Mark as pending before async operation
    core.state.pendingSheds.add(deviceId);
    try {
      const shedTemperatureResult = await dispatchTrySetShedTemperature(core, {
        deviceId,
        name,
        targetCap,
        shedTemp,
        canSetShedTemp,
      });
      if (!shedTemperatureResult.handled) {
        return applyBinarySheddingToDevice(core.buildBinaryExecutorContext(), {
          deviceId,
          deviceName: name,
          reason,
          skipPrecheck: true,
          trackPendingShed: false,
        });
      }
      return shedTemperatureResult.wrote;
    } finally {
      core.state.pendingSheds.delete(deviceId);
    }
  } finally {
    core.flushLastControlledPersistence();
  }
};

const dispatchTrySetShedTemperature = async (
  core: PlanExecutorCore,
  params: {
    deviceId: string;
    name: string;
    targetCap: string | undefined;
    shedTemp: number | null;
    canSetShedTemp: boolean;
  },
): Promise<PlanActionHandleResult> => trySetShedTemperature(core.buildTargetExecutorContext(), params);
