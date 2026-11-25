import type { DevicePlan } from './planTypes';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isMeteredPlanDevice } from './planMeteredDevice';
import { isSteppedLoadDevice, isPlanDeviceObservedOff, isPlanDeviceObservedOn } from './planSteppedLoad';
import { buildPlannedSteppedCommand, resolveSteppedLoadCurrentFallback } from './planSteppedCommand';
import { isCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { getSteppedLoadStep, isSteppedLoadOffStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  isDeferredRestoreBlockedReason, isRestoreAdmissionHoldReason, isSwapTargetPendingReason,
} from '../planContract/planDecisionSemantics';
import { hasStorageDecision } from '../planContract/storageDecision';
import { hasPlannedStep, type PlannedDeviceCommands, type PlannedBinaryCommand, type PlannedReleaseCommand,
  type StableExecutionOperation, type PlannedSteppedCommand, type ExecutionPlan,
  type PlannedBinaryDrive, type PlannedCommandAxes, type PlannedTargetPowerClaim } from '../planContract/executionPlan';
import type { DeviceLimitReason, DroppedSteppedShedIntent } from '../planContract/executionPlan';
type PlanDevice = DevicePlan['devices'][number];
type PlanMeta = DevicePlan['meta'];
type PlannedCommandPlan = { devices: PlannedDeviceCommands[] };
export function buildExecutablePlan(plan: DevicePlan): PlannedCommandPlan {
  return {
    devices: plan.devices.map((device) => (
      buildExecutableDeviceIntentSafe(device, plan.meta, plan.ordinaryStartsHeld === true)
    )),
  };
}

export function buildExecutableDeviceIntent(
  planDevice: PlanDevice, planMeta?: PlanMeta, ordinaryStartsHeld = false,
): PlannedDeviceCommands {
  const target = planDevice.targetCommand;
  const installation = planDevice.controlAdapter?.chargingInstallation;
  const binary = resolveDeviceBinaryIntent(planDevice, ordinaryStartsHeld);
  const release = buildPlannedReleaseCommand(planDevice, planMeta, ordinaryStartsHeld);
  const step = installation && installation.mainId !== planDevice.id
    ? undefined : buildPlannedSteppedCommand(planDevice, ordinaryStartsHeld);
  const steppedLoad = installation && step ? installationStepOnly(step) : step;
  // The claim follows from PELS's authority over the device this cycle, a
  // smart task's included, and not from this cycle's step: a device the plan
  // leaves alone or holds off is claimed too. A device PELS only watches is not.
  const targetPowerClaim: PlannedTargetPowerClaim | undefined = planDevice.targetPowerClaimNeeded === true
    && planDevice.control.commandAuthority ? { deviceId: planDevice.id, name: planDevice.name } : undefined;
  // Attach a command only for an axis the plan drives; absence IS the answer, so
  // no consumer re-derives it. See `PlannedDeviceCommands` and `PlannedCommandAxes`.
  const commands: PlannedDeviceCommands & PlannedCommandAxes = {
    id: planDevice.id,
    name: planDevice.name,
    commandAuthority: planDevice.control.commandAuthority,
    projection: 'decided',
    ...buildDeviceLimitAttribution(planDevice, planMeta),
    ...(target ? { target } : {}),
    ...(binary ? { binary } : {}),
    ...(release ? { release } : {}),
    ...(steppedLoad ? { steppedLoad } : {}),
    ...(targetPowerClaim ? { targetPowerClaim } : {}),
  };
  return commands;
}

function resolveDeviceBinaryIntent(device: PlanDevice, ordinaryStartsHeld: boolean): PlannedBinaryCommand | undefined {
  const command = device.controlAdapter?.chargingInstallation
    ? device.chargingInstallationSwitch : buildPlannedBinaryCommand(device);
  // A keep intent can turn a device back on if it switches OFF after the
  // build, and an installation member can start on a kept shared limit.
  return ordinaryStartsHeld && !device.lastResort && command?.desiredOn ? undefined : command;
}

function installationStepOnly(
  step: PlannedSteppedCommand & Partial<PlannedBinaryDrive>,
): PlannedSteppedCommand {
  const { desiredOn: _binaryDrive, transition, ...command } = step;
  const { desired } = command;
  return {
    ...command,
    desired: isSteppedLoadOffStep(command.steppedLoadProfile, desired.stepId)
      ? { ...desired, stepId: undefined } : desired,
    transition: transition && { ...transition, binaryTarget: null },
  };
}

function buildDeviceLimitAttribution(
  device: PlanDevice,
  planMeta?: PlanMeta,
): Pick<PlannedDeviceCommands, 'deviceLimit'> {
  const reason = resolveDeviceLimitReason(device);
  if (!reason) return {};
  const availablePowerKw = planMeta?.powerIsMeasured ? planMeta.headroomKw : null;
  return {
    deviceLimit: { reason, ...(availablePowerKw !== null ? { availablePowerKw } : {}) },
  };
}

function resolveDeviceLimitReason(device: PlanDevice): DeviceLimitReason | undefined {
  if (device.plannedState !== 'shed' || device.deferredReleaseIntent?.kind === 'shed_release') return undefined;
  switch (device.reason?.code) {
    case PLAN_REASON_CODES.awaitingSolarSurplus: return 'solar_surplus';
    case PLAN_REASON_CODES.dailyBudget: return 'daily_budget';
    case PLAN_REASON_CODES.gridImport: return 'grid_import';
    case PLAN_REASON_CODES.phaseLimit: return 'main_fuse';
    case PLAN_REASON_CODES.meterSilent: return 'meter_unavailable';
    case PLAN_REASON_CODES.capacity:
    case PLAN_REASON_CODES.hourlyBudget:
    case PLAN_REASON_CODES.endOfHourDrain:
    case PLAN_REASON_CODES.swappedOut:
    case PLAN_REASON_CODES.shortfall: return 'capacity';
    default: return undefined;
  }
}

function buildExecutableDeviceIntentSafe(
  planDevice: PlanDevice, planMeta: PlanMeta, ordinaryStartsHeld: boolean,
): PlannedDeviceCommands {
  try {
    return buildExecutableDeviceIntent(planDevice, planMeta, ordinaryStartsHeld);
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
  || planDevice.reason?.code === PLAN_REASON_CODES.carCurrentRangeUnavailable
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

function buildLastResortBinaryCommand(dev: PlanDevice): PlannedBinaryCommand | undefined {
  if (!dev.lastResort || !dev.control.commandAuthority || !dev.lastResortCommand) return undefined;
  if (dev.lastResortCommand === 'on' && (dev.plannedState !== 'keep'
    || isRestoreAdmissionHoldReason(dev.reason) || isSwapTargetPendingReason(dev.reason))) return undefined;
  if (dev.lastResortCommand === 'off' && dev.plannedState !== 'shed') return undefined;
  return {
    deviceId: dev.id, name: dev.name, desiredOn: dev.lastResortCommand === 'on',
    lastResortMaximumW: dev.lastResort.maximumW, source: 'controlled', ...binarySwitchAuthority(dev),
  };
}

/** The binary intent projected from a finalized device decision. */
const binarySwitchAuthority = (dev: PlanDevice): { binarySwitchGeneration?: number } => (
  dev.binarySwitchGeneration === undefined ? {} : { binarySwitchGeneration: dev.binarySwitchGeneration }
);

export const buildPlannedBinaryCommand = (dev: PlanDevice): PlannedBinaryCommand | undefined => {
  if (dev.waitingForTaskPlan && dev.plannedState !== 'shed') return undefined;
  if (isSteppedLoadDevice(dev)) return undefined;
  if (!isBinaryPlanDevice(dev)) return undefined;
  if (dev.lastResort) return buildLastResortBinaryCommand(dev);
  // A device can remain visible before power setup, or after losing its power
  // facet. Neither permits an ON intent, even when it has a standing shed.
  if (!isMeteredPlanDevice(dev)) return undefined;
  if (dev.control.commandAuthority === false) {
    return dev.plannedState === 'keep'
      ? { deviceId: dev.id, name: dev.name, desiredOn: true, source: 'uncontrolled', ...binarySwitchAuthority(dev) }
      : undefined;
  }
  if (dev.plannedState !== 'shed' && dev.plannedState !== 'keep') return undefined;
  // A pending swap target or a restore-admission hold leaves the binary axis
  // alone, whether the device is kept or shed.
  if (isSwapTargetPendingReason(dev.reason)) return undefined;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return undefined;
  if (dev.plannedState === 'shed') return buildExecutableBinaryShedIntent(dev);
  return { deviceId: dev.id, name: dev.name, desiredOn: true, source: 'controlled', ...binarySwitchAuthority(dev) };
};

const buildExecutableBinaryShedIntent = (dev: PlanDevice): PlannedBinaryCommand | undefined => {
  // A shed whose end state is the setpoint has no binary intent to issue.
  if (dev.plannedShedTargetKind === 'target_value') return undefined;
  return {
    deviceId: dev.id,
    name: dev.name,
    desiredOn: false,
    ...binarySwitchAuthority(dev),
    ...(!isPostureHoldShed(dev) ? dev.relayShedDecision : undefined),
    // A shed never rides the managed -> unmanaged release path; that path only
    // ever turns a device back ON.
    source: 'controlled',
  };
};

const buildPlannedReleaseCommand = (
  dev: PlanDevice,
  planMeta: PlanMeta | undefined,
  ordinaryStartsHeld: boolean,
): PlannedReleaseCommand | undefined => {
  const release = dev.deferredReleaseIntent;
  if (!release || dev.lastResort) return undefined;
  const { kind } = release;
  // The release intent is producer-resolved in deferred-objective admission. This per-cycle
  // projection only reconciles a binary_restore (resume) against the current cycle's planner
  // state — power-freshness (re-evaluated every cycle, incl. realtime reconcile) and the final
  // plan reason — via shared predicates in planDecisionSemantics. The actual executor
  // (planExecutor) then actuates the resulting intent flatly, without re-checking reasons.
  if (kind === 'shed_release') return { ...release, deviceId: dev.id, name: dev.name, ...binarySwitchAuthority(dev) };
  if (kind === 'binary_release') return { kind, deviceId: dev.id, name: dev.name, ...binarySwitchAuthority(dev) };
  // binary_restore is the only positive (turn-on) intent: require a MEASURED power
  // sample (avoid racing the capacity guard), the device kept, no pending swap target,
  // and a plan reason that does not block restore (capacity/cooldown/etc).
  //
  // Reads the producer-resolved `powerIsMeasured`, not the freshness label: this is
  // the same question `planBuilderDecoration` answers for the same intent, and testing
  // the label here answered it differently (a fresh timestamp with no total counted as
  // fresh). `undefined` on an older persisted plan means "do not block" — unchanged
  // from the previous optional-chained read.
  if (ordinaryStartsHeld || planMeta?.powerIsMeasured === false) return undefined;
  if (dev.plannedState !== 'keep') return undefined;
  if (isSwapTargetPendingReason(dev.reason)) return undefined;
  if (dev.reason && isDeferredRestoreBlockedReason(dev.reason)) return undefined;
  return { kind, deviceId: dev.id, name: dev.name, ...binarySwitchAuthority(dev) };
};

/** Project a finalized decision at the planner's outward boundary. No observation or command lifecycle runs here. */
export function buildExecutionPlan(plan: DevicePlan): ExecutionPlan {
  const commands = buildExecutablePlan(plan);
  return {
    ...(!plan.meta.powerIsMeasured ? { meterSilenceStamp: plan.meta.lastPowerUpdateMs } : {}),
    devices: plan.devices.map((device, index) => {
      const intent = commands.devices[index]!;
      const stepDownToRetire = device.stepDownToRetire;
      const stillRequested = hasPlannedStep(intent) && intent.steppedLoad.desired.stepId === stepDownToRetire?.stepId;
      return {
        commands: intent,
        ...(stepDownToRetire && !stillRequested ? { stepDownToRetire } : {}),
        stableOperations: qualifyStableOperations(device, intent),
        stepBaseline: resolveSteppedLoadCurrentFallback(device),
        nonCapacityHoldShed: device.nonCapacityHoldShed === true,
      };
    }),
    hasShedDevices: hasExecutableShedDevices(plan, commands),
    droppedSteppedSheds: findDroppedSteppedShedIntents(plan, commands),
    storageDevices: plan.devices.filter(hasStorageDecision).map(({ id, name, storageDecision }) => (
      { id, name, storageDecision }
    )),
    storageReleases: plan.storageReleases,
    inverterDecisions: plan.inverterDecisions,
    chargingPhaseDecisions: plan.chargingPhaseDecisions,
  };
}

function qualifyStableOperations(device: PlanDevice, commands: PlannedDeviceCommands): StableExecutionOperation[] {
  const step = hasPlannedStep(commands) && isSteppedLoadDevice(device)
    && (device.plannedState === 'keep' || isRunningLimitPreparation(device, commands.steppedLoad))
    ? commands.steppedLoad
    : undefined;
  const operations: (StableExecutionOperation | undefined)[] = [
    isMeteredPlanDevice(device) && !device.control.commandAuthority
      && device.plannedState === 'keep' && isPlanDeviceObservedOff(device)
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
    isRunningLimitPreparation(device, step)
      || (desired.id !== device.selectedStepId && (!selected || desired.planningPowerW !== selected.planningPowerW))
      ? 'step_change' : undefined,
  ];
}

function isRunningLimitPreparation(device: PlanDevice, step: PlannedSteppedCommand): boolean {
  return isPlanDeviceObservedOn(device)
    && step.transition?.effectiveTransition === 'step_down_while_on'
    && step.transition.transitionPhase === 'step_preparation';
}

function hasStableSteppedBinaryRestore(device: PlanDevice, step: PlannedSteppedCommand): boolean {
  return isBinaryPlanDevice(device) && !device.currentOn && step.transition?.binaryTarget === true
    && step.transition.transitionPhase === 'binary_transition';
}
