import {
  getBinaryOn,
  isBinaryControlled,
  isBinaryOnOrUnknown,
} from '../../packages/shared-domain/src/binaryControlState';
import { isBinaryPlanDevice } from '../plan/planBinaryDevice';
import type { DevicePlan } from '../plan/planTypes';
import {
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadTransition,
} from '../plan/planSteppedLoad';
import { resolveSteppedRestoreAttemptState } from '../plan/planSteppedRestorePending';
import { resolveEffectiveCurrentOn } from '../plan/planCurrentState';
import {
  allowsSteppedLoadKeepInvariantRestore,
  isRestoreAdmissionHoldReason,
} from '../planContract/planDecisionSemantics';
import {
  resolveSteppedStepActuationState,
  type ExecutableSteppedStepState,
} from './steppedLoadActuation';
import type {
  ExecutableObservedDeviceState,
  ExecutableShedTarget,
  ExecutableObservedSteppedLoadState,
  ExecutableSteppedLoadCurrentFallback,
  ExecutableSteppedLoadCommandSession,
  ExecutableSteppedLoadCurrentState,
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
} from './executablePlan';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';

type PlanDevice = DevicePlan['devices'][number];

export function buildExecutableSteppedLoadIntent(dev: PlanDevice): ExecutableSteppedLoadIntent | undefined {
  if (!isSteppedLoadDevice(dev)) return undefined;
  if (shouldHoldCurrentState(dev)) return undefined;
  const planningCurrent = {
    on: resolveEffectiveCurrentOn(dev),
    stepId: dev.selectedStepId,
    stepForShed: resolveCurrentStepForShed(dev),
    stepIsOffStep: isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId),
  };
  const plannedStepId = resolveSteppedKeepDesiredStepId(dev);
  const plannedTransition = resolveSteppedLoadTransition(dev, plannedStepId);
  const { desired, desiredOn } = resolveDesiredState({
    dev,
    current: planningCurrent,
    plannedStepId,
    plannedTransition,
  });
  if (isUnderspecifiedSetStepShedIntent(dev, desired)) return undefined;
  const transition = desiredMatchesTransition(desired, desiredOn, plannedTransition)
    ? plannedTransition
    : null;
  const matchingRestoreAttempt = desired.stepId !== undefined
    ? resolveSteppedRestoreAttemptState(dev, desired.stepId)
    : null;
  const matchingCommandAttempt = desired.stepId !== undefined
    ? resolveSteppedRestoreAttemptState(dev, desired.stepId)
    : null;
  const intent: ExecutableSteppedLoadIntent = {
    id: dev.id,
    name: dev.name,
    steppedLoadProfile: dev.steppedLoadProfile,
    communicationModel: dev.communicationModel,
    controlAdapter: dev.controlAdapter,
    plannedShedTarget: toExecutableShedTarget(dev.plannedShedTargetKind, desired.stepId),
    desired,
    // The binary axis is attached ONLY when this cycle's decision moves it.
    // `resolveDesiredOn` answers `null` for the steady / step-up / step-down
    // transitions, where the plan has something to say about the step and
    // nothing about the on/off handle — previously that `null` travelled as a
    // third value every consumer re-interpreted through `!== true`.
    ...(desiredOn !== null ? { desiredOn } : {}),
    previousStepId: dev.selectedStepId,
    transition,
    matchingRestoreAttempt,
    matchingCommandAttempt,
    stepCommandRetryCount: dev.stepCommandRetryCount ?? 0,
    nextStepCommandRetryAtMs: dev.nextStepCommandRetryAtMs,
    // Strictly the COMMANDED step: a success that cannot be tied to its
    // commanded step (e.g. the tracked step id was filtered out by a profile
    // edit) confirms nothing — no fallback to the planner's desired step.
    confirmedCommandStepId: dev.stepCommandStatus === 'success'
      ? dev.lastDesiredStepId
      : undefined,
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
): ExecutableSteppedLoadCurrentFallback | undefined {
  if (!isSteppedLoadDevice(dev)) return undefined;
  return {
    on: resolveEffectiveCurrentOn(dev),
    stepId: dev.selectedStepId,
  };
}

export function buildExecutableSteppedLoadDevice(
  intent: ExecutableSteppedLoadIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
  currentFallback?: ExecutableSteppedLoadCurrentFallback,
  commandSession?: ExecutableSteppedLoadCommandSession,
): ExecutableSteppedLoadDevice | null {
  if (!intent) return null;
  const resolvedObserved = withCommandSessionReportedStep(observed, commandSession);
  const current = buildCurrentState(intent, resolvedObserved, currentFallback);
  const initializationStepId = resolveInitializationStepId(intent, resolvedObserved, commandSession);
  const initializesUnknownStep = initializationStepId !== undefined;
  const desired = initializesUnknownStep
    ? { ...intent.desired, stepId: initializationStepId }
    : intent.desired;
  const transition: ExecutableSteppedLoadDevice['transition'] = initializesUnknownStep
    ? {
      effectiveTransition: 'initialize_unknown_step_at_low',
      stepPreparationPurpose: 'initialize_unknown_step',
      binaryTarget: null,
      commandStepId: initializationStepId,
      plannedDesiredStepId: intent.desired.plannedStepId ?? intent.desired.stepId,
      transitionPhase: 'step_preparation',
    }
    : intent.transition;
  // A confirmed step command counts as restore-preparation evidence ONLY while
  // the device is observed off (trusted off) — the restore-preparation window.
  // While on, observed reports keep sole materialization authority so clamped
  // devices still get adjusted. Requires a present observation: `current.on`
  // falls back to the plan-derived value when the device is absent from this
  // cycle's snapshot, and a plan-derived 'off' is not trusted-off evidence.
  const confirmedCommandStepId = resolvedObserved !== undefined && current.on === false
    ? intent.confirmedCommandStepId
    : undefined;
  const stepActuation = resolveSteppedStepActuationState({
    step: toExecutableSteppedStepState(
      resolvedObserved?.steppedLoad,
      desired.stepId,
      confirmedCommandStepId,
    ),
  });
  // Same inputs, same resolution — the two fields exist for their distinct
  // consumers (restore gating vs command dispatch), not distinct semantics.
  const commandStepActuation = stepActuation;
  const desiredIsNonOff = desired.stepId
    && !isSteppedLoadOffStep(intent.steppedLoadProfile, desired.stepId);
  return {
    ...intent,
    current,
    desired,
    transition,
    previousStepId: current.stepId ?? intent.previousStepId,
    stepActuation,
    commandStepActuation,
    stepNeedsAdjustment: Boolean(desiredIsNonOff && stepActuation.materialization.kind !== 'materialized'),
    initializationStepId,
  };
}

const withCommandSessionReportedStep = (
  observed: ExecutableObservedDeviceState | undefined,
  commandSession: ExecutableSteppedLoadCommandSession | undefined,
): ExecutableObservedDeviceState | undefined => {
  const reportedStepId = commandSession?.reportedStepId;
  if (!observed || !reportedStepId) return observed;
  if (observed.steppedLoad?.reportedStepId !== undefined) return observed;
  return {
    ...observed,
    steppedLoad: {
      on: observed.steppedLoad?.on ?? null,
      stepId: reportedStepId,
      reportedStepId,
      // The `?? 0` covers a MISSING stepped-load state, not a missing draw: this
      // synthesizes one for a device the projection did not classify as stepped,
      // and about such a device's draw nothing is known — the same answer the
      // producer gives for an unmetered device.
      currentDrawKw: observed.steppedLoad?.currentDrawKw ?? 0,
    },
  };
};

const resolveInitializationStepId = (
  intent: ExecutableSteppedLoadIntent,
  observed: ExecutableObservedDeviceState | undefined,
  commandSession: ExecutableSteppedLoadCommandSession | undefined,
): string | undefined => {
  // Initialization is a KEEP-side concern: a shed already has a decided
  // destination (`plannedShedTarget`), so there is no unknown step to seed.
  if (intent.plannedShedTarget !== undefined) return undefined;
  if (!isBinaryControlled(observed) || !getBinaryOn(observed)) return undefined;
  if (observed.steppedLoad?.reportedStepId !== undefined) return undefined;
  if (commandSession?.reportedStepId !== undefined) return undefined;
  if (!commandSession || commandSession.hasPriorStepCommand) return undefined;
  const lowestActiveStep = getSteppedLoadLowestActiveStep(intent.steppedLoadProfile);
  const desiredStep = intent.desired.stepId
    ? getSteppedLoadStep(intent.steppedLoadProfile, intent.desired.stepId)
    : undefined;
  if (!lowestActiveStep || !desiredStep || desiredStep.planningPowerW <= 0) return undefined;
  return commandSession.initializationAssumedStepId === lowestActiveStep.id
    ? undefined
    : lowestActiveStep.id;
};

const buildCurrentState = (
  intent: ExecutableSteppedLoadIntent,
  observedDevice: ExecutableObservedDeviceState | undefined,
  currentFallback: ExecutableSteppedLoadCurrentFallback | undefined,
): ExecutableSteppedLoadCurrentState => {
  const observed = observedDevice?.steppedLoad;
  // Current state is producer-resolved: from the observation when present, else
  // from the plan-device fallback the observed-state producer supplies for a
  // device absent from this cycle's snapshot. The intent carries desired-only
  // state and never contributes current state here.
  const stepId = observed?.stepId ?? currentFallback?.stepId;
  return {
    on: observed?.on
      ?? (observedDevice ? isBinaryOnOrUnknown(observedDevice) : (currentFallback?.on ?? null)),
    stepId,
    stepForShed: resolveObservedStepForShed(intent, observed, stepId),
    stepIsOffStep: stepId
      ? isSteppedLoadOffStep(intent.steppedLoadProfile, stepId)
      : false,
  };
};

const toExecutableSteppedStepState = (
  observed: ExecutableObservedSteppedLoadState | null | undefined,
  requestedStepId?: string,
  confirmedCommandStepId?: string,
): ExecutableSteppedStepState => {
  const observedStepId = observed?.reportedStepId;
  // The effective `stepId` is the planning fallback only when there is no
  // reported step; when a report exists `stepId` mirrors it and is not a
  // separate fallback.
  const fallbackStepId = observedStepId ? undefined : observed?.stepId;
  return {
    requestedStepId,
    observedStep: observedStepId ? { kind: 'reported', stepId: observedStepId } : { kind: 'unknown' },
    fallbackStepId,
    confirmedCommandStepId,
  };
};

/**
 * Pairs the producer-decided kind (`plannedShedTargetKind`) with the step THIS
 * layer resolved. The executor pairs; it never decides the kind — see
 * `ExecutableShedTarget`.
 */
const toExecutableShedTarget = (
  kind: PlanDevice['plannedShedTargetKind'],
  desiredStepId: string | undefined,
): ExecutableShedTarget | undefined => {
  if (kind === undefined) return undefined;
  return kind === 'step' ? { kind, stepId: desiredStepId } : { kind };
};

// A shed the plan decided should end at a step, for which no step could be
// resolved, is not actionable — drop the intent rather than emit a destination
// the executor cannot converge on.
const isUnderspecifiedSetStepShedIntent = (
  dev: PlanDevice,
  desired: ExecutableSteppedLoadDevice['desired'],
): boolean => (
  dev.plannedShedTargetKind === 'step'
  && desired.stepId === undefined
);

const resolveDesiredState = (params: {
  dev: PlanDevice;
  current: ExecutableSteppedLoadDevice['current'];
  plannedStepId?: string;
  plannedTransition: ReturnType<typeof resolveSteppedLoadTransition>;
}): { desired: ExecutableSteppedLoadDevice['desired']; desiredOn: boolean | null } => {
  const {
    dev,
    current,
    plannedStepId,
    plannedTransition,
  } = params;
  const desiredStepId = resolveDesiredStepId({
    dev,
    current,
    plannedStepId,
    plannedTransition,
  });
  return {
    desired: { stepId: desiredStepId, plannedStepId },
    desiredOn: resolveDesiredOn({ dev, current, plannedTransition, desiredStepId }),
  };
};

const resolveDesiredStepId = (params: {
  dev: PlanDevice;
  current: ExecutableSteppedLoadDevice['current'];
  plannedStepId?: string;
  plannedTransition: ReturnType<typeof resolveSteppedLoadTransition>;
}): string | undefined => {
  const {
    dev,
    current,
    plannedStepId,
    plannedTransition,
  } = params;
  const desiredStepId = plannedTransition?.commandStepId ?? plannedStepId;
  if (dev.plannedState !== 'shed' || !desiredStepId || !isSteppedLoadDevice(dev)) return desiredStepId;

  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, desiredStepId);
  const currentPowerW = current.stepForShed?.planningPowerW ?? 0;
  if (!desiredStep || desiredStep.planningPowerW <= currentPowerW) return desiredStepId;
  return current.stepId;
};

const desiredMatchesTransition = (
  desired: ExecutableSteppedLoadDevice['desired'],
  desiredOn: boolean | null,
  transition: ReturnType<typeof resolveSteppedLoadTransition>,
): boolean => {
  if (!transition) return false;
  if (desired.stepId !== transition.commandStepId) return false;
  return transition.binaryTarget === null || desiredOn === transition.binaryTarget;
};

const resolveDesiredOn = (params: {
  dev: PlanDevice;
  current: ExecutableSteppedLoadDevice['current'];
  plannedTransition: ReturnType<typeof resolveSteppedLoadTransition>;
  desiredStepId: string | undefined;
}): boolean | null => {
  const {
    dev, current, plannedTransition, desiredStepId,
  } = params;
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
  // binary projection already filters that way, and `resolveConvergenceDesiredBinaryState`
  // carves `inactive` out explicitly. That is a behaviour change, so it is filed
  // rather than bundled here.
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
  // an observation. A device that moved on its own is an
  // ordinary input — `scheduleAppRealtimeDeviceReconcile` queues a rebuild, and
  // the planner answers with an explicit `restore_from_off_at_low` (binaryTarget
  // true) or decides to leave it and shed something else. Inferring it here can
  // only ever produce the first answer, which is the apply-without-decide path
  // `inc_26449fb9` came from (`lib/plan/AGENTS.md`).
  return null;
};

const shouldHoldCurrentState = (dev: PlanDevice): boolean => (
  Boolean(dev.reason && isRestoreAdmissionHoldReason(dev.reason))
  || Boolean(dev.reason && dev.plannedState === 'keep' && !allowsSteppedLoadKeepInvariantRestore(dev.reason))
);

const resolveCurrentStepForShed = (
  dev: PlanDevice,
): ExecutableSteppedLoadDevice['current']['stepForShed'] => {
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

const resolveObservedStepForShed = (
  intent: ExecutableSteppedLoadIntent,
  observed: ExecutableObservedSteppedLoadState | null | undefined,
  stepId: string | undefined,
): ExecutableSteppedLoadCurrentState['stepForShed'] => {
  if (stepId) {
    const currentStep = getSteppedLoadStep(intent.steppedLoadProfile, stepId);
    return currentStep ? {
      stepId: currentStep.id,
      planningPowerW: currentStep.planningPowerW,
    } : undefined;
  }
  // Only a shed whose end state is a step needs the current rung priced; a shed
  // that ends with the device off has nothing to descend from.
  if (intent.plannedShedTarget?.kind !== 'step') return undefined;
  // The producer's number is finite by construction (`getCurrentDrawKw`
  // normalizes or answers 0); only "is it drawing?" is still worth asking —
  // the same test `resolvePlanStepForShed` applies on the plan-device path.
  if (observed === null || observed === undefined || observed.currentDrawKw <= 0) {
    return undefined;
  }
  return {
    stepId: 'unknown',
    planningPowerW: Math.round(observed.currentDrawKw * 1000),
  };
};
