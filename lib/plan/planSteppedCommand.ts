import type { DevicePlan, SteppedPlanDevice } from './planTypes';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isPlanDeviceObservedOff, isPlanDeviceObservedOn, isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId, resolveSteppedLoadTransition } from './planSteppedLoad';
import {
  allowsSteppedLoadKeepInvariantRestore, isRestoreAdmissionHoldReason,
} from '../planContract/planDecisionSemantics';
import type {
  PlannedSteppedCommand, PlannedStepBaseline, PlannedStepDesiredState, PlannedShedTarget,
} from '../planContract/executionPlan';
import { getSteppedLoadStep, isSteppedLoadOffStep } from '../../packages/shared-domain/src/deviceControlProfiles';
type PlanDevice = DevicePlan['devices'][number];
type PlanningSteppedState = PlannedStepBaseline & {
  stepForShed?: { stepId: string; planningPowerW: number };
  stepIsOffStep: boolean;
};
const resolvePlanDeviceObservedOn = (device: PlanDevice): boolean | null => {
  if (isPlanDeviceObservedOn(device)) return true;
  if (isPlanDeviceObservedOff(device)) return false;
  return null;
};

const isIdleTaskReleaseWithoutAuthority = (dev: PlanDevice): boolean => (
  !dev.control.commandAuthority && dev.deferredReleaseIntent?.kind === 'shed_release'
);

export function buildPlannedSteppedCommand(dev: PlanDevice): PlannedSteppedCommand | undefined {
  if (!isSteppedLoadDevice(dev)) return undefined;
  // A restore hold may allow lowering a controlled device; lack of authority
  // never does. Lifecycle release has its own explicit grant and dispatch path.
  if (!dev.control.commandAuthority && dev.deferredReleaseIntent === undefined) return undefined;
  const planningCurrent = {
    on: resolvePlanDeviceObservedOn(dev),
    stepId: dev.selectedStepId,
    stepForShed: resolveCurrentStepForShed(dev),
    stepIsOffStep: isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId),
  };
  const plannedStepId = resolveSteppedKeepDesiredStepId(dev);
  const held = isHeldByPlanReason(dev);
  const releaseWithoutAuthority = isIdleTaskReleaseWithoutAuthority(dev);
  // The step-only lifecycle release needs the ladder even when the ordinary
  // plan leaves the rung alone. Its dispatcher resolves the release step.
  if (held && !releaseWithoutAuthority && !isKeptStepDown(dev, planningCurrent, plannedStepId)) return undefined;
  const plannedTransition = resolveSteppedLoadTransition(dev, plannedStepId);
  const desiredStepId = resolveDesiredStepId(dev, planningCurrent, plannedStepId, plannedTransition);
  const desired = { stepId: desiredStepId, plannedStepId };
  // A held step-down moves the step only, and only down (`stepDirection`): the
  // hold still blocks the binary axis, so a device read off at dispatch is not
  // turned on.
  const desiredOn = held ? null : resolveDesiredOn(dev, planningCurrent, plannedTransition, desiredStepId);
  if (isUnderspecifiedSetStepShedIntent(dev, desired)) return undefined;
  const transition = desiredMatchesTransition(desired, desiredOn, plannedTransition)
    ? plannedTransition
    : null;
  const intent: PlannedSteppedCommand = {
    id: dev.id,
    name: dev.name,
    steppedLoadProfile: dev.steppedLoadProfile,
    controlAdapter: dev.controlAdapter,
    plannedShedTarget: toPlannedShedTarget(dev.plannedShedTargetKind, desired.stepId),
    desired,
    stepDirection: held ? 'down_only' : 'any',
    // The binary axis is attached ONLY when this cycle's decision moves it.
    // `resolveDesiredOn` answers `null` for the steady / step-up / step-down
    // transitions, where the plan has something to say about the step and
    // nothing about the on/off handle — previously that `null` travelled as a
    // third value every consumer re-interpreted through `!== true`.
    ...(desiredOn !== null ? { desiredOn } : {}),
    previousStepId: dev.selectedStepId,
    transition,
  };
  return intent;
}

/**
 * Producer-resolved current fallback from the plan device. Used by the
 * device-projection only when the device has no observation this cycle; the
 * resolution (effective on + effective step) lives here, in the producer layer,
 * so the executor never re-derives a planning fallback.
 */
export function resolveSteppedLoadCurrentFallback(
  dev: PlanDevice,
): PlannedStepBaseline | undefined {
  if (!isSteppedLoadDevice(dev)) return undefined;
  return {
    on: resolvePlanDeviceObservedOn(dev),
    stepId: dev.selectedStepId,
  };
}

/**
 * Pairs the producer-decided kind (`plannedShedTargetKind`) with the step THIS
 * layer resolved. The planner pairs the selected kind with the decided command step — see
 * `PlannedShedTarget`.
 */
const toPlannedShedTarget = (
  kind: PlanDevice['plannedShedTargetKind'],
  desiredStepId: string | undefined,
): PlannedShedTarget | undefined => {
  if (kind === undefined) return undefined;
  return kind === 'step' ? { kind, stepId: desiredStepId } : { kind };
};

// A shed the plan decided should end at a step, for which no step could be
// resolved, is not actionable — drop the intent rather than emit a destination
// the executor cannot converge on.
const isUnderspecifiedSetStepShedIntent = (
  dev: PlanDevice,
  desired: PlannedStepDesiredState,
): boolean => (
  dev.plannedShedTargetKind === 'step'
  && desired.stepId === undefined
);

const resolveDesiredStepId = (
  dev: PlanDevice,
  current: PlanningSteppedState,
  plannedStepId: string | undefined,
  plannedTransition: ReturnType<typeof resolveSteppedLoadTransition>,
): string | undefined => {
  const desiredStepId = plannedTransition?.commandStepId ?? plannedStepId;
  if (dev.plannedState !== 'shed' || !desiredStepId || !isSteppedLoadDevice(dev)) return desiredStepId;

  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, desiredStepId);
  const currentPowerW = current.stepForShed?.planningPowerW ?? 0;
  if (!desiredStep || desiredStep.planningPowerW <= currentPowerW) return desiredStepId;
  return current.stepId;
};

const desiredMatchesTransition = (
  desired: PlannedStepDesiredState,
  desiredOn: boolean | null,
  transition: ReturnType<typeof resolveSteppedLoadTransition>,
): boolean => {
  if (!transition) return false;
  if (desired.stepId !== transition.commandStepId) return false;
  return transition.binaryTarget === null || desiredOn === transition.binaryTarget;
};

const resolveDesiredOn = (
  dev: PlanDevice,
  current: PlanningSteppedState,
  plannedTransition: ReturnType<typeof resolveSteppedLoadTransition>,
  desiredStepId: string | undefined,
): boolean | null => {
  if (plannedTransition?.binaryTarget !== null && plannedTransition?.binaryTarget !== undefined) {
    return plannedTransition.binaryTarget;
  }
  if (dev.plannedState === 'shed' && current.stepIsOffStep) return false;
  // A KEEP is a decision that the device should be running, so the binary axis
  // is driven ON by that decision — exactly as `buildExecutableBinaryIntent`
  // answers for a kept binary device. It must NOT be read off `current.on`: a
  // DESIRED-state field has to carry a decision, never an observation. The old
  // read made one field mean two things depending on which arm filled it, and
  // let the executor drive a device from stale state. (Not the `inc_26449fb9`
  // shape, which was a LANE-wide exemption from retry suppression and cooldown
  // stamping — this was a field-level leak with no lane and no brake bypass.)
  // Same value in the common case, decided rather than inferred.
  // `inactive` is the third `PlannedDeviceState`, and it must not fall through to
  // "the plan does not move this axis". PELS is not driving this device AT ALL —
  // `getInactiveReason` sets it when the device is not commandable this cycle, or
  // is held off by something outside PELS. Letting `desiredOn` go absent here
  // removes `isSettledAtPlannedOff`'s skip, so a step command reaches a device
  // that cannot answer it and stamps a shed cooldown or opens an activation
  // attempt on its behalf. That is what `commandableNow === false` exists to
  // prevent. `false` reproduces the pre-cluster value exactly (`current.on` was
  // false for every inactive producer, all of which run on off devices).
  //
  // The honest shape is no stepped intent at all for an inactive device — the
  // binary projection already filters that way. That is a behaviour change, so
  // it is filed rather than bundled here.
  if (dev.plannedState === 'inactive') return false;
  if (dev.plannedState === 'keep') {
    // No binary handle means no binary axis to drive, so the plan drives none:
    // a step-only stepper's restore rides the step axis (see
    // `hasStableSteppedLoadBinaryRestoreActuation`). Answering `true` here would
    // push it through the binary restore lane it has no use for — which is a
    // behaviour change, not a rename.
    if (!isBinaryPlanDevice(dev)) return null;
    if (desiredStepId === undefined || !isSteppedLoadDevice(dev)) return true;
    return !isSteppedLoadOffStep(dev.steppedLoadProfile, desiredStepId);
  }
  // `null` = this cycle's decision does not move the binary axis. It must NOT
  // fall back to `current.on`: a desired-state field carries a decision, never
  // an observation. A device that moved on its own is an ordinary input — the
  // next whole-home reading rebuilds with it, and the planner answers with an
  // explicit `restore_from_off_at_low` (binaryTarget true) or decides to leave it
  // and shed something else. Inferring it here can only ever produce the first
  // answer, which is the apply-without-decide path `inc_26449fb9` came from
  // (`lib/plan/AGENTS.md`).
  return null;
};

/**
 * The plan holds this device where it is: a restore-admission hold, or a keep
 * reason other than `keep` / `restoreNeed`. Only a kept step-down passes it
 * (`isKeptStepDown`).
 */
const isHeldByPlanReason = (dev: PlanDevice): boolean => (
  Boolean(dev.reason && isRestoreAdmissionHoldReason(dev.reason))
  || Boolean(dev.reason && dev.plannedState === 'keep' && !allowsSteppedLoadKeepInvariantRestore(dev.reason))
);

/**
 * Owner ruling: a hold blocks raising a device, never lowering it. A kept
 * device the plan sees running, planned to a lower step than its current one,
 * steps down whatever reason the plan carries. A shed device, a step-up and a
 * device observed off stay held. This judges the plan's view; dispatch checks
 * the live report again (`stepDirection: 'down_only'`).
 */
const isKeptStepDown = (
  dev: SteppedPlanDevice,
  current: PlanningSteppedState,
  plannedStepId: string | undefined,
): boolean => {
  if (dev.plannedState !== 'keep' || isPlanDeviceObservedOff(dev) || !current.stepForShed) return false;
  const plannedStep = getSteppedLoadStep(dev.steppedLoadProfile, plannedStepId);
  return plannedStep !== null && plannedStep.planningPowerW < current.stepForShed.planningPowerW;
};

const resolveCurrentStepForShed = (
  dev: PlanDevice,
): PlanningSteppedState['stepForShed'] => {
  if (!isSteppedLoadDevice(dev)) return undefined;
  // A `selectedStepId` outside the (possibly capped) planner profile is a real
  // domain state, not a presence gap — no measured-draw fallback lane exists
  // anymore: the producer guarantees the effective step for every stepped
  // device.
  const currentStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.selectedStepId);
  return currentStep ? {
    stepId: currentStep.id,
    planningPowerW: currentStep.planningPowerW,
  } : undefined;
};
