import type { DevicePlan } from '../plan/planTypes';
import { isBinaryDrivenIntent } from './executableDesiredState';
import {
  hasBinaryCommand,
  hasReleaseCommand,
  hasSteppedCommand,
  hasTargetCommand,
} from './executablePlan';
import { shouldSkipUnavailable } from './executorSupport';
import { getDebugEmitter, getLogger } from '../logging/logger';
import type {
  ExecutableBinaryIntent,
  ExecutableDeviceIntent,
  ExecutableObservedDeviceState,
  ExecutablePlan,
  ExecutableReleaseIntent,
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
  ExecutableTargetIntent,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import type { ExecutorDeviceRead } from './executorDeviceRead';
import type { ExecutorCommandContext } from './executorCommandContext';
import { applyShedTemperaturePlan, applyTargetUpdate } from './targetExecutor';
import {
  applySteppedLoadCommand,
  applySteppedLoadRestore,
  applySteppedLoadShedOff,
} from './steppedLoadExecutor';
import {
  applyBinaryRestore,
  applyBinarySheddingToDevice,
  applyDeferredBinaryCommand,
  applyUncontrolledBinaryRestore,
} from './binaryExecutor';
import { applyShedReleaseIntent } from './shedReleaseActuation';
import {
  buildExecutableObservedDeviceState,
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
import type { PlanActuationResult } from '../planContract/planActuationResult';
import { hasStorageDecision } from '../planContract/storageDecision';
import type { StorageLane } from './batteryExecutor';

const logger = getLogger('executor/plan');
/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

/**
 * One device's contribution. Deliberately NOT `PlanActuationResult`: that is the
 * plan-wide total, which also counts apply failures a per-device delta cannot
 * know. Aliasing the two is what let a plan-wide "something was written" answer
 * be attributed to every device in a batch.
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

/**
 * The per-device dispatch context: the device's observation, the plan-wide shed
 * flag, and the intent's commands resolved ONCE through the `has*Command` guards. Downstream branches read these locals
 * instead of re-narrowing the intent at each of ~14 call sites; `undefined`
 * here means the plan does not drive that axis, which the appliers treat as a
 * no-op.
 */
type ResolvedDeviceIntent = {
  observed: ExecutableObservedDeviceState | undefined;
  snapshot: ExecutorDeviceSnapshot | undefined;
  hasShedDevices: boolean;
  steppedAction: ExecutableSteppedLoadDevice | null;
  targetCommand: ExecutableTargetIntent | undefined;
  binaryCommand: ExecutableBinaryIntent | undefined;
  releaseCommand: ExecutableReleaseIntent | undefined;
  steppedCommand: ExecutableSteppedLoadIntent | undefined;
};

const resolveDeviceCommands = (intent: ExecutableDeviceIntent): Pick<
  ResolvedDeviceIntent,
  'targetCommand' | 'binaryCommand' | 'releaseCommand' | 'steppedCommand'
> => ({
  targetCommand: hasTargetCommand(intent) ? intent.target : undefined,
  binaryCommand: hasBinaryCommand(intent) ? intent.binary : undefined,
  releaseCommand: hasReleaseCommand(intent) ? intent.release : undefined,
  steppedCommand: hasSteppedCommand(intent) ? intent.steppedLoad : undefined,
});

const resolveLatestObservedDevice = (
  ctx: ExecutorCommandContext,
  deviceId: string,
  observed: ExecutableObservedDeviceState | undefined,
): ExecutableObservedDeviceState | undefined => {
  const device = ctx.readDevice(deviceId);
  return device ? buildExecutableObservedDeviceState(device, undefined) : observed;
};

const applyShedTemperatureIntent = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableTargetIntent,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  const command = buildExecutableTargetCommand(intent, observed);
  if (ctx.getCapacityDryRun()) {
    logger.info({ event: 'executor_plan_log', msg: 'Capacity (dry run): would set '
      + `${command ? 'temperature' : 'target'} for ${intent.name} to ${intent.desired}°C (shedding)` });
    return false;
  }
  if (!command) return false;
  if (Object.is(command.observedValue, command.desired)) {
    emitExecutorDebug({ event: 'executor_plan_log_debug', msg: `Capacity: skip setting temperature `
      + `for ${intent.name}, already at ${intent.desired}°C` });
    return false;
  }
  return applyShedTemperaturePlan(ctx, command);
};

const applyTargetIntent = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableTargetIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  if (!intent) return false;
  const latestObserved = resolveLatestObservedDevice(ctx, intent.deviceId, observed);
  if (intent.purpose === 'shed_temperature') {
    return applyShedTemperatureIntent(ctx, intent, latestObserved);
  }
  const update = buildExecutableTargetUpdate(intent, latestObserved);
  return update ? applyTargetUpdate(ctx, update) : false;
};

const applyBinaryShedIntent = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableBinaryIntent | undefined,
): Promise<boolean> => {
  if (!intent || intent.desiredOn) return false;
  // The PLAN decided this end state, so the apply path must not decide it again.
  // A binary shed intent exists only when `plannedShedTargetKind` is not
  // `target_value` (`buildExecutableBinaryShedIntent`), so re-reading the owner's
  // configured behaviour here could only ever contradict the plan — and did: a
  // thermostat with an on/off handle and a `set_temperature` floor was written to
  // its setback and left running under a plan that said off, which is how the
  // start-policy hold failed to turn one off at all.
  return applyBinarySheddingToDevice(ctx, intent.deviceId, intent.name);
};

const dispatchSteppedLoadCommand = async (
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice | null,
  snapshot: ExecutorDeviceSnapshot | undefined,
): Promise<boolean> => (action ? applySteppedLoadCommand(ctx, action, snapshot) : false);

const applyUncontrolledDeviceIntent = async (
  ctx: ExecutorCommandContext,
  device: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { observed, snapshot, steppedAction, targetCommand, binaryCommand, releaseCommand, steppedCommand } = device;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  // Cap-off + deferred release is the lifecycle-end path: the deferred objective
  // was the only reason PELS was driving this device, and it just transitioned out
  // of plannable status. Fire the device's configured release posture and skip the
  // uncontrolled-restore so we don't immediately re-enable what we just released.
  if (releaseCommand?.kind === 'binary_release') {
    if (await dispatchSteppedLoadCommand(ctx, steppedAction, snapshot)) commandRequestCount += 1;
    if (await applyDeferredBinaryCommand(ctx, releaseCommand, observed)) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  if (releaseCommand?.kind === 'shed_release') {
    if (await applyShedReleaseIntent(ctx, releaseCommand, steppedCommand, observed)) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  if (await dispatchSteppedLoadCommand(ctx, steppedAction, snapshot)) commandRequestCount += 1;
  if (await applyUncontrolledBinaryRestore(ctx, binaryCommand, observed)) deviceWriteCount += 1;
  if (await applyTargetIntent(ctx, targetCommand, observed)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applySteppedRestoreFromOffIntent = async (
  ctx: ExecutorCommandContext,
  device: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { observed, snapshot, steppedAction, hasShedDevices, targetCommand } = device;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  if (steppedAction === null || !isBinaryDrivenIntent(steppedAction.intent) || !steppedAction.intent.desiredOn) {
    if (await applyTargetIntent(ctx, targetCommand, observed)) deviceWriteCount += 1;
    return delta(deviceWriteCount, commandRequestCount);
  }
  const prepareCurrentFirst = steppedAction.intent.controlAdapter?.activationOrder === 'current_before_start';
  if (prepareCurrentFirst && !isRequestedStepMaterialized(steppedAction.stepActuation)) {
    const requested = await applySteppedLoadCommand(ctx, steppedAction, snapshot);
    return delta(deviceWriteCount, Number(requested));
  }
  const stepRestore = await applySteppedLoadRestore(ctx, steppedAction, snapshot, hasShedDevices);
  if (
    stepRestore.ready
    && !prepareCurrentFirst
    && (
      stepRestore.wroteBinary
      || !isRequestedStepMaterialized(steppedAction.stepActuation)
    )
    && await applySteppedLoadCommand(ctx, steppedAction, snapshot, {
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
  if (await applyTargetIntent(ctx, targetCommand, observed)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applySteppedShedRestoreIntent = async (
  ctx: ExecutorCommandContext,
  device: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { observed, snapshot, steppedAction, hasShedDevices, targetCommand } = device;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  if (steppedAction) {
    if (await applySteppedLoadCommand(ctx, steppedAction, snapshot)) commandRequestCount += 1;
    if (await applySteppedLoadShedOff(ctx, steppedAction, snapshot)) deviceWriteCount += 1;
    const restored = await applySteppedLoadRestore(ctx, steppedAction, snapshot, hasShedDevices);
    if (restored.wroteBinary) deviceWriteCount += 1;
  }
  if (await applyTargetIntent(ctx, targetCommand, observed)) deviceWriteCount += 1;
  return delta(deviceWriteCount, commandRequestCount);
};

const applyDefaultBinaryIntent = async (
  ctx: ExecutorCommandContext,
  device: ResolvedDeviceIntent,
): Promise<DispatchDelta> => {
  const { observed, targetCommand, binaryCommand, releaseCommand } = device;
  let deviceWriteCount = 0;
  if (await applyDeferredBinaryCommand(ctx, releaseCommand, observed)) {
    return delta(1, 0);
  }
  if (await applyBinaryRestore(ctx, binaryCommand, observed)) deviceWriteCount += 1;
  if (await applyTargetIntent(ctx, targetCommand, observed)) deviceWriteCount += 1;
  return delta(deviceWriteCount, 0);
};

const applyDeviceIntent = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableDeviceIntent,
  observed: ExecutableObservedDeviceState | undefined,
  hasShedDevices: boolean,
  steppedFallback: ReturnType<typeof resolveSteppedLoadCurrentFallback>,
): Promise<DispatchDelta> => {
  if (intent.projectionError) throw intent.projectionError;
  const commands = resolveDeviceCommands(intent);
  const { steppedCommand } = commands;
  const steppedAction = buildExecutableSteppedLoadDevice(
    steppedCommand,
    observed,
    steppedFallback,
    ctx.getSteppedLoadCommandSession(intent.id),
  );
  const snapshot = observed?.snapshot;
  if (shouldSkipUnavailable(snapshot, intent.name, 'actuation')) return ZERO_DELTA;
  const device: ResolvedDeviceIntent = {
    observed, snapshot, hasShedDevices, steppedAction, ...commands,
  };
  if (intent.commandAuthority === false) return applyUncontrolledDeviceIntent(ctx, device);
  if (isSteppedLoadRestoreFromOff(steppedCommand, steppedAction)) {
    return applySteppedRestoreFromOffIntent(ctx, device);
  }
  if (steppedCommand) return applySteppedShedRestoreIntent(ctx, device);
  if (device.targetCommand?.purpose === 'shed_temperature') {
    return (await applyTargetIntent(ctx, device.targetCommand, observed))
      ? delta(1, 0)
      : ZERO_DELTA;
  }
  if (device.binaryCommand?.desiredOn === false) {
    return (await applyBinaryShedIntent(ctx, device.binaryCommand)) ? delta(1, 0) : ZERO_DELTA;
  }
  return applyDefaultBinaryIntent(ctx, device);
};

const logUnderspecifiedSteppedShedDevices = (
  plan: DevicePlan,
  exec: ExecutablePlan,
): void => {
  for (const dropped of findDroppedSteppedShedIntents(plan, exec)) {
    emitExecutorDebug({
      event: 'stepped_load_shed_intent_dropped',
      reasonCode: 'underspecified_set_step',
      ...dropped,
    });
  }
};

/**
 * Carries out a plan against the executor's current read of every device, then
 * the storage lane's decisions.
 */
export const dispatchPlanActions = async (
  ctx: ExecutorCommandContext,
  plan: DevicePlan,
  devices: ExecutorDeviceRead[],
  storage: StorageLane,
): Promise<PlanActuationResult> => {
  const executablePlan = buildExecutablePlan(plan);
  const observedMap = new Map(devices.map((device) => [
    device.id,
    buildExecutableObservedDeviceState(device, undefined),
  ]));
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
  let deviceApplyFailureCount = 0;
  for (const intent of executablePlan.devices) {
    try {
      const result = await applyDeviceIntent(
        ctx,
        intent,
        observedMap.get(intent.id),
        hasShedDevices,
        steppedFallbackMap.get(intent.id),
      );
      deviceWriteCount += result.deviceWriteCount;
      commandRequestCount += result.commandRequestCount;
    } catch (error) {
      deviceApplyFailureCount += 1;
      logger.error({
        event: 'executor_plan_error',
        msg: `Failed to apply action for ${intent.name}; continuing with remaining devices`,
        err: error,
      });
    }
  }
  // Batteries after every shed: a slow cloud battery must never delay one.
  const storageResult = await dispatchStorageDecisions(storage, plan);
  return {
    deviceWriteCount,
    commandRequestCount: commandRequestCount + storageResult.commandRequestCount,
    deviceApplyFailureCount: deviceApplyFailureCount + storageResult.failureCount,
  };
};

/** The plan's home-battery decisions, through the storage lane (none in a meter area). */
const dispatchStorageDecisions = async (
  storage: StorageLane,
  plan: DevicePlan,
): Promise<{ commandRequestCount: number; failureCount: number }> => {
  let commandRequestCount = 0;
  let failureCount = 0;
  for (const device of plan.devices) {
    if (!hasStorageDecision(device)) continue;
    try {
      if (await storage.apply(device)) commandRequestCount += 1;
    } catch (error) {
      failureCount += 1;
      logger.error({
        event: 'executor_plan_error',
        reasonCode: 'storage_decision_failed',
        deviceId: device.id,
        deviceName: device.name,
        err: error,
      });
    }
  }
  for (const intent of plan.storageReleases) {
    try {
      if (await storage.releaseAbsent(intent)) commandRequestCount += 1;
    } catch (error) {
      failureCount += 1;
      logger.error({
        event: 'executor_plan_error', reasonCode: 'storage_release_failed', deviceId: intent.deviceId, err: error,
      });
    }
  }
  return { commandRequestCount, failureCount };
};
