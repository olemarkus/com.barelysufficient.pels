import { isBinaryObservedOff } from '../../packages/shared-domain/src/binaryControlState';
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
import type { PlanActuationMode } from './executorTypes';
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

const logger = getLogger('executor/plan');

export type PlanActuationResult = {
  deviceWriteCount: number;
  commandRequestCount: number;
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
  recordReleaseShedActuation: (deviceId: string, name: string, now: number) => void;
  latestTargetSnapshot: () => ExecutorDeviceSnapshot[];
  capacityDryRun: () => boolean;
  state: PlanEngineState;
  flushLastControlledPersistence: () => void;
  // Routes through the spyable instance method so `applyPlanActions` → binary shed
  // still hits any test spy on `executor.applySheddingToDevice`.
  applySheddingToDevice: (deviceId: string, deviceName: string, reason?: string) => Promise<boolean>;
};

type DispatchDelta = PlanActuationResult;

const delta = (deviceWriteCount: number, commandRequestCount: number): DispatchDelta => ({
  deviceWriteCount,
  commandRequestCount,
});

const ZERO_DELTA: DispatchDelta = { deviceWriteCount: 0, commandRequestCount: 0 };

type DeviceIntentArgs = {
  intent: ExecutablePlan['devices'][number];
  observed: ExecutableObservedDeviceState | undefined;
  snapshot: ExecutorDeviceSnapshot | undefined;
  mode: PlanActuationMode;
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
  mode: PlanActuationMode,
): Promise<boolean> => applyBinaryRestore(core.buildBinaryExecutorContext(), intent, observed, mode);

const applyDeferredBinaryIntent = async (
  core: PlanExecutorCore,
  intent: ExecutableReleaseIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => applyDeferredBinaryCommand(core.buildBinaryExecutorContext(), intent, observed, mode);

const dispatchShedReleaseIntent = async (
  core: PlanExecutorCore,
  params: {
    intent: ExecutableReleaseIntent;
    steppedLoadIntent: ExecutableSteppedLoadIntent | null;
    observed: ExecutableObservedDeviceState | undefined;
    snapshot: ExecutorDeviceSnapshot | undefined;
    mode: PlanActuationMode;
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
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (!intent) return false;
  const latestObserved = resolveLatestObservedDevice(core, intent.deviceId, observed);
  if (intent.purpose === 'shed_temperature') {
    return applyShedTemperatureIntent(core, intent, latestObserved);
  }
  return applyTargetUpdate(
    core.buildTargetExecutorContext(),
    buildTargetUpdateAction(core, intent, latestObserved),
    mode,
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
  mode: PlanActuationMode,
  snapshot?: ExecutorDeviceSnapshot,
  options: { recordPlanActuation?: boolean } = {},
): Promise<boolean> => (action
  ? applySteppedLoadCommand(core.buildSteppedExecutorContext(), action, mode, snapshot, options)
  : false);

const dispatchSteppedLoadRestore = async (
  core: PlanExecutorCore,
  action: ExecutableSteppedLoadDevice | null,
  params: {
    snapshot: ExecutorDeviceSnapshot | undefined;
    mode: PlanActuationMode;
    hasShedDevices: boolean;
    options?: { preRestoreStepIssued?: boolean };
  },
) => (action
  ? applySteppedLoadRestore(core.buildSteppedExecutorContext(), { action, ...params })
  : { ready: false, wroteBinary: false });

const dispatchSteppedLoadShedOff = async (
  core: PlanExecutorCore,
  action: ExecutableSteppedLoadDevice | null,
  snapshot: ExecutorDeviceSnapshot | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => (action
  ? applySteppedLoadShedOff(core.buildSteppedExecutorContext(), action, snapshot, mode)
  : false);

const applyUncontrolledDeviceIntent = async (
  core: PlanExecutorCore,
  ctx: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { intent, observed, snapshot, steppedAction, mode } = ctx;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  // Cap-off + deferred release is the lifecycle-end path: the deferred objective
  // was the only reason PELS was driving this device, and it just transitioned out
  // of plannable status. Fire the device's configured release posture and skip the
  // uncontrolled-restore so we don't immediately re-enable what we just released.
  if (intent.release?.kind === 'binary_release') {
    if (await dispatchSteppedLoadCommand(core, steppedAction, mode, snapshot)) commandRequestCount += 1;
    if (await applyDeferredBinaryIntent(core, intent.release, observed, mode)) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  if (intent.release?.kind === 'shed_release') {
    if (await dispatchShedReleaseIntent(core, {
      intent: intent.release,
      steppedLoadIntent: intent.steppedLoad,
      observed,
      snapshot,
      mode,
    })) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  if (await dispatchSteppedLoadCommand(core, steppedAction, mode, snapshot)) commandRequestCount += 1;
  if (await applyUncontrolledRestore(core, intent.binary, observed)) deviceWriteCount += 1;
  if (await applyTargetIntent(core, intent.target, observed, mode)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applySteppedRestoreFromOffIntent = async (
  core: PlanExecutorCore,
  ctx: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { intent, observed, snapshot, steppedAction, mode, hasShedDevices } = ctx;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  if (steppedAction?.desired.on !== true) {
    if (await applyTargetIntent(core, intent.target, observed, mode)) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  const onoffViolated = isBinaryObservedOff(snapshot);
  const preRestoreStepIssued = onoffViolated
    ? await dispatchSteppedLoadCommand(core, steppedAction, mode, snapshot, { recordPlanActuation: false })
    : false;
  if (preRestoreStepIssued) commandRequestCount += 1;
  const stepRestore = await dispatchSteppedLoadRestore(core, steppedAction, {
    snapshot,
    mode,
    hasShedDevices,
    options: { preRestoreStepIssued },
  });
  if (
    stepRestore.ready
    && !onoffViolated
    && await dispatchSteppedLoadCommand(core, steppedAction, mode, snapshot)
  ) commandRequestCount += 1;
  if (stepRestore.wroteBinary) deviceWriteCount += 1;
  if (await applyTargetIntent(core, intent.target, observed, mode)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applySteppedShedRestoreIntent = async (
  core: PlanExecutorCore,
  ctx: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { intent, observed, snapshot, steppedAction, mode, hasShedDevices } = ctx;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  if (await dispatchSteppedLoadCommand(core, steppedAction, mode, snapshot)) commandRequestCount += 1;
  if (await dispatchSteppedLoadShedOff(core, steppedAction, snapshot, mode)) deviceWriteCount += 1;
  const restored = await dispatchSteppedLoadRestore(core, steppedAction, { snapshot, mode, hasShedDevices });
  if (restored.wroteBinary) deviceWriteCount += 1;
  if (await applyTargetIntent(core, intent.target, observed, mode)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applyDefaultBinaryIntent = async (
  core: PlanExecutorCore,
  ctx: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { intent, observed, mode } = ctx;
  let deviceWriteCount = 0;
  if (await applyDeferredBinaryIntent(core, intent.release, observed, mode)) {
    return delta(1, 0);
  }
  if (await applyBinaryRestoreIntent(core, intent.binary, observed, mode)) deviceWriteCount += 1;
  if (await applyTargetIntent(core, intent.target, observed, mode)) deviceWriteCount += 1;
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
    return (await applyTargetIntent(core, intent.target, args.observed, args.mode))
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
  mode: PlanActuationMode,
): void => {
  for (const dropped of findDroppedSteppedShedIntents(plan, exec)) {
    logger.debug({
      event: 'stepped_load_shed_intent_dropped',
      reasonCode: 'underspecified_set_step',
      actuationMode: mode,
      ...dropped,
    });
  }
};

export const dispatchPlanActions = async (
  core: PlanExecutorCore,
  plan: DevicePlan,
  mode: PlanActuationMode,
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
  logUnderspecifiedSteppedShedDevices(plan, executablePlan, mode);
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  for (const intent of executablePlan.devices) {
    const observed = observedMap.get(intent.id);
    const snapshot = observed?.snapshot;
    try {
      const result = await applyDeviceIntent(core, {
        intent,
        observed,
        snapshot,
        mode,
        hasShedDevices,
        steppedFallback: steppedFallbackMap.get(intent.id),
      });
      deviceWriteCount += result.deviceWriteCount;
      commandRequestCount += result.commandRequestCount;
    } catch (error) {
      logger.error({
        event: 'executor_plan_error',
        msg: `Failed to apply action for ${intent.name}; continuing with remaining devices`,
        err: error,
      });
    }
  }
  return { deviceWriteCount, commandRequestCount };
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
