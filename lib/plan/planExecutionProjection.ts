import type { DevicePlan } from './planTypes';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isSteppedLoadDevice, isPlanDeviceObservedOff, isPlanDeviceObservedOn } from './planSteppedLoad';
import { buildPlannedSteppedCommand, resolveSteppedLoadCurrentFallback } from './planSteppedCommand';
import { isCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  isDeferredRestoreBlockedReason, isRestoreAdmissionHoldReason, isSwapTargetPendingReason,
} from '../planContract/planDecisionSemantics';
import { hasStorageDecision } from '../planContract/storageDecision';
import { hasPlannedStep, type PlannedDeviceCommands, type PlannedBinaryCommand, type PlannedReleaseCommand,
  type StableExecutionOperation, type PlannedSteppedCommand, type ExecutionPlan,
  type PlannedCommandAxes } from '../planContract/executionPlan';
import type { DroppedSteppedShedIntent } from '../planContract/executionPlan';
type PlanDevice = DevicePlan['devices'][number];
type PlanMeta = DevicePlan['meta'];
type PlannedCommandPlan = { devices: PlannedDeviceCommands[] };
export function buildExecutablePlan(plan: DevicePlan): PlannedCommandPlan {
  return {
    devices: plan.devices.map((device) => buildExecutableDeviceIntentSafe(device, plan.meta)),
  };
}

export function buildExecutableDeviceIntent(planDevice: PlanDevice, planMeta?: PlanMeta): PlannedDeviceCommands {
  const target = planDevice.targetCommand;
  const binary = buildPlannedBinaryCommand(planDevice);
  const release = buildPlannedReleaseCommand(planDevice, planMeta);
  const steppedLoad = buildPlannedSteppedCommand(planDevice);
  // Attach a command only for an axis the plan drives; absence IS the answer, so
  // no consumer re-derives it. See `PlannedDeviceCommands` and `PlannedCommandAxes`.
  const commands: PlannedDeviceCommands & PlannedCommandAxes = {
    id: planDevice.id,
    name: planDevice.name,
    commandAuthority: planDevice.control.commandAuthority,
    projection: 'decided',
    ...(target ? { target } : {}),
    ...(binary ? { binary } : {}),
    ...(release ? { release } : {}),
    ...(steppedLoad ? { steppedLoad } : {}),
  };
  return commands;
}

function buildExecutableDeviceIntentSafe(planDevice: PlanDevice, planMeta?: PlanMeta): PlannedDeviceCommands {
  try {
    return buildExecutableDeviceIntent(planDevice, planMeta);
  } catch (error) {
    return {
      id: planDevice.id,
      name: planDevice.name,
      commandAuthority: planDevice.control.commandAuthority,
      projection: 'failed',
      error,
    };
  }
}

/**
 * Executor-facing shed posture for the keep-invariant gate.
 *
 * Counts any planner-shed device EXCEPT the underspecified stepped `set_step` case where
 * the executor projection cannot resolve a target step. Devices held off by restore
 * admission (cooldown / meter settling) still count as shed posture: they are currently
 * shed, just temporarily uncommandable. Excluding only the phantom underspecified
 * `set_step` drop prevents it from blocking unrelated stepped restores at the lowest
 * non-zero step, without losing posture for legitimate held-shed devices.
 */
export function hasExecutableShedDevices(
  plan: DevicePlan,
  executablePlan: PlannedCommandPlan,
): boolean {
  for (const [index, planDevice] of plan.devices.entries()) {
    if (planDevice.plannedState !== 'shed') continue;
    if (isDroppedUnderspecifiedSetStepShed(planDevice, executablePlan.devices[index])) continue;
    if (isPostureHoldShed(planDevice)) continue;
    return true;
  }
  return false;
}

// A STANDING POSTURE (a "Run on solar surplus" hold, the start policy, the
// charge target) is an opt-in posture whose baseline is off, not capacity
// pressure, so it must NOT count toward the keep-invariant stepped-restore block
// (`applyKeepInvariantShedBlock`), which caps unrelated stepped loads at their
// lowest non-zero step while any device is shed for capacity. Each is
// discriminated on its reason code rather than on the producer flags behind it:
// a device that is genuinely capacity-shed carries a `capacity` reason and MUST
// still block, whatever its posture settings say. See `notes/state-management/`.
//
// A smart task's deferred-hour hold is read off the plan's decided flag
// (`nonCapacityHoldShed`) instead: it covers both standing and borrowed authority,
// while preserving the same "no fresh capacity reason" rule.
const isPostureHoldShed = (planDevice: PlanDevice): boolean => (
  planDevice.reason?.code === PLAN_REASON_CODES.awaitingSolarSurplus
  || planDevice.reason?.code === PLAN_REASON_CODES.awaitingPelsStart
  || planDevice.reason?.code === PLAN_REASON_CODES.chargeTargetReached
  || planDevice.reason?.code === PLAN_REASON_CODES.awaitingBatteryLevel
  || planDevice.nonCapacityHoldShed === true
);

/**
 * Stepped-load shed intents the planner emitted that the executor projection dropped
 * specifically because the `set_step` target step could not be resolved. Surfacing these
 * makes the silent drop detectable in production with a reliable reason code.
 *
 * Other null-projection causes (restore admission hold, malformed profiles) are
 * intentionally excluded so the `underspecified_set_step` diagnostic stays meaningful.
 */
export function findDroppedSteppedShedIntents(
  plan: DevicePlan,
  executablePlan: PlannedCommandPlan,
): DroppedSteppedShedIntent[] {
  const result: DroppedSteppedShedIntent[] = [];
  for (const [index, planDevice] of plan.devices.entries()) {
    if (!isDroppedUnderspecifiedSetStepShed(planDevice, executablePlan.devices[index])) continue;
    // eslint-disable-next-line functional/immutable-data -- Local accumulator over plan devices.
    result.push({
      deviceId: planDevice.id,
      deviceName: planDevice.name,
      selectedStepId: isSteppedLoadDevice(planDevice) ? planDevice.selectedStepId : null,
      desiredStepId: planDevice.desiredStepId ?? null,
    });
  }
  return result;
}

const isDroppedUnderspecifiedSetStepShed = (
  planDevice: PlanDevice,
  executableDevice: PlannedDeviceCommands | undefined,
): boolean => (
  isSteppedLoadDevice(planDevice)
  && planDevice.plannedShedTargetKind === 'step'
  // A MISSING executable device is not a dropped shed — the old `?.steppedLoad
  // === null` answered false for `undefined`, and this arm feeds
  // `hasExecutableShedDevices`, which gates the keep-invariant stepped-restore
  // block. Only a device that IS projected and carries no step command counts.
  && executableDevice !== undefined
  && !hasPlannedStep(executableDevice)
  && !isHeldByRestoreAdmission(planDevice)
);

const isHeldByRestoreAdmission = (planDevice: PlanDevice): boolean => (
  Boolean(planDevice.reason && isRestoreAdmissionHoldReason(planDevice.reason))
);

const buildPlannedBinaryCommand = (dev: PlanDevice): PlannedBinaryCommand | undefined => {
  if (isSteppedLoadDevice(dev)) return undefined;
  if (!isBinaryPlanDevice(dev)) return undefined;
  if (dev.control.commandAuthority === false) {
    return dev.plannedState === 'keep'
      ? { deviceId: dev.id, name: dev.name, desiredOn: true, source: 'uncontrolled' }
      : undefined;
  }
  if (dev.plannedState !== 'shed' && dev.plannedState !== 'keep') return undefined;
  // A pending swap target or a restore-admission hold leaves the binary axis
  // alone, whether the device is kept or shed.
  if (isSwapTargetPendingReason(dev.reason)) return undefined;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return undefined;
  if (dev.plannedState === 'shed') return buildExecutableBinaryShedIntent(dev);
  return { deviceId: dev.id, name: dev.name, desiredOn: true, source: 'controlled' };
};

const buildExecutableBinaryShedIntent = (dev: PlanDevice): PlannedBinaryCommand | undefined => {
  // A shed whose end state is the setpoint has no binary intent to issue.
  if (dev.plannedShedTargetKind === 'target_value') return undefined;
  return {
    deviceId: dev.id,
    name: dev.name,
    desiredOn: false,
    // A shed never rides the managed -> unmanaged release path; that path only
    // ever turns a device back ON.
    source: 'controlled',
  };
};

const buildPlannedReleaseCommand = (
  dev: PlanDevice,
  planMeta?: PlanMeta,
): PlannedReleaseCommand | undefined => {
  const release = dev.deferredReleaseIntent;
  if (!release) return undefined;
  const { kind } = release;
  // The release intent is producer-resolved in deferred-objective admission. This per-cycle
  // projection only reconciles a binary_restore (resume) against the current cycle's planner
  // state — power-freshness (re-evaluated every cycle, incl. realtime reconcile) and the final
  // plan reason — via shared predicates in planDecisionSemantics. The actual executor
  // (planExecutor) then actuates the resulting intent flatly, without re-checking reasons.
  if (kind === 'shed_release') return { ...release, deviceId: dev.id, name: dev.name };
  if (kind === 'binary_release') return { kind, deviceId: dev.id, name: dev.name };
  // binary_restore is the only positive (turn-on) intent: require a MEASURED power
  // sample (avoid racing the capacity guard), the device kept, no pending swap target,
  // and a plan reason that does not block restore (capacity/cooldown/etc).
  //
  // Reads the producer-resolved `powerIsMeasured`, not the freshness label: this is
  // the same question `planBuilderDecoration` answers for the same intent, and testing
  // the label here answered it differently (a fresh timestamp with no total counted as
  // fresh). `undefined` on an older persisted plan means "do not block" — unchanged
  // from the previous optional-chained read.
  if (planMeta?.powerIsMeasured === false) return undefined;
  if (dev.plannedState !== 'keep') return undefined;
  if (isSwapTargetPendingReason(dev.reason)) return undefined;
  if (dev.reason && isDeferredRestoreBlockedReason(dev.reason)) return undefined;
  return { kind, deviceId: dev.id, name: dev.name };
};

/** Project a finalized decision at the planner's outward boundary. No observation or command lifecycle runs here. */
export function buildExecutionPlan(plan: DevicePlan): ExecutionPlan {
  const commands = buildExecutablePlan(plan);
  return {
    devices: plan.devices.map((device, index) => ({
      commands: commands.devices[index]!,
      stableOperations: qualifyStableOperations(device, commands.devices[index]!),
      stepBaseline: resolveSteppedLoadCurrentFallback(device),
      nonCapacityHoldShed: device.nonCapacityHoldShed === true,
    })),
    hasShedDevices: hasExecutableShedDevices(plan, commands),
    droppedSteppedSheds: findDroppedSteppedShedIntents(plan, commands),
    storageDevices: plan.devices.filter(hasStorageDecision).map(({ id, name, storageDecision }) => (
      { id, name, storageDecision }
    )),
    storageReleases: plan.storageReleases,
    inverterDecisions: plan.inverterDecisions,
  };
}

function qualifyStableOperations(device: PlanDevice, commands: PlannedDeviceCommands): StableExecutionOperation[] {
  const step = hasPlannedStep(commands) && isSteppedLoadDevice(device)
    && (device.plannedState === 'keep' || commands.steppedLoad.transition?.transitionPhase === 'step_preparation')
    ? commands.steppedLoad
    : undefined;
  const operations: (StableExecutionOperation | undefined)[] = [
    !device.control.commandAuthority && device.plannedState === 'keep' && isPlanDeviceObservedOff(device)
      ? 'uncontrolled_restore' : undefined,
    hasStableBinaryRelease(device) ? 'binary_release' : undefined,
    ...(step ? qualifyStableStepOperations(device, step) : []),
    step && hasStableSteppedBinaryRestore(device, step) ? 'binary_restore' : undefined,
  ];
  return operations.filter((operation): operation is StableExecutionOperation => operation !== undefined);
}

function hasStableBinaryRelease(device: PlanDevice): boolean {
  const release = device.deferredReleaseIntent?.kind;
  return (release === 'binary_restore' && isBinaryPlanDevice(device) && !device.currentOn && isCommandableNow(device))
    || (release === 'binary_release' && (!isBinaryPlanDevice(device) || device.currentOn));
}

function qualifyStableStepOperations(
  device: PlanDevice,
  step: PlannedSteppedCommand,
): (StableExecutionOperation | undefined)[] {
  if (!isSteppedLoadDevice(device)) return [];
  const desired = getSteppedLoadStep(device.steppedLoadProfile, step.desired.plannedStepId);
  if (!desired) return [];
  const selected = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
  return [
    device.reportedStepId === undefined && isPlanDeviceObservedOn(device) && desired.planningPowerW > 0
      ? 'initialize_step' : undefined,
    step.transition?.transitionPhase === 'step_preparation'
      || (desired.id !== device.selectedStepId && selected && desired.planningPowerW !== selected.planningPowerW)
      ? 'step_change' : undefined,
  ];
}

function hasStableSteppedBinaryRestore(device: PlanDevice, step: PlannedSteppedCommand): boolean {
  return isBinaryPlanDevice(device) && !device.currentOn && step.transition?.binaryTarget === true
    && step.transition.transitionPhase === 'binary_transition';
}
