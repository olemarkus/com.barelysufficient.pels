import {
  getBinaryOn, isBinaryControlled, isBinaryOnOrUnknown,
} from '../../packages/shared-domain/src/binaryControlState';
import { resolveSteppedStepActuationState, type ExecutableSteppedStepState } from './steppedLoadActuation';
import type { ExecutableObservedDeviceState, ExecutableObservedSteppedLoadState,
  ExecutableSteppedLoadCommandSession, ExecutableSteppedLoadCurrentState,
  ExecutableSteppedLoadDevice, ExecutableSteppedLoadIntent, ExecutableSteppedLoadState } from './executablePlan';
import {
  getSteppedLoadLowestActiveStep, getSteppedLoadStep, isSteppedLoadOffStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
export function buildExecutableSteppedLoadDevice(
  intent: ExecutableSteppedLoadIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
  currentFallback: ExecutableSteppedLoadState | undefined,
  commandSession: ExecutableSteppedLoadCommandSession,
): ExecutableSteppedLoadDevice | null {
  if (!intent) return null;
  const resolvedObserved = withCommandSessionReportedStep(observed, commandSession);
  const current = buildCurrentState(intent, resolvedObserved, currentFallback);
  const initializationStepId = resolveInitializationStepId(intent, resolvedObserved, commandSession);
  const initializesUnknownStep = initializationStepId !== undefined;
  const desired = initializesUnknownStep
    ? { ...intent.desired, stepId: initializationStepId }
    : intent.desired;
  const transition: ExecutableSteppedLoadIntent['transition'] = initializesUnknownStep
    ? {
      effectiveTransition: 'initialize_unknown_step_at_low',
      stepPreparationPurpose: 'initialize_unknown_step',
      binaryTarget: null,
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
    step: intent.controlAdapter?.activationOrder === 'current_before_start'
      ? toPreparedCurrentStepState(intent.steppedLoadProfile, resolvedObserved?.steppedLoad, desired.stepId,
        confirmedCommandStepId)
      : toExecutableSteppedStepState(resolvedObserved?.steppedLoad, desired.stepId, confirmedCommandStepId),
  });
  const desiredIsNonOff = desired.stepId
    && !isSteppedLoadOffStep(intent.steppedLoadProfile, desired.stepId);
  return {
    intent: { ...intent, desired, transition },
    current,
    stepActuation,
    stepNeedsAdjustment: Boolean(desiredIsNonOff && stepActuation.materialization.kind !== 'materialized'),
  };
}

const withCommandSessionReportedStep = (
  observed: ExecutableObservedDeviceState | undefined,
  commandSession: ExecutableSteppedLoadCommandSession,
): ExecutableObservedDeviceState | undefined => {
  const reportedStepId = commandSession.reportedStepId;
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
  commandSession: ExecutableSteppedLoadCommandSession,
): string | undefined => {
  // Initialization is a KEEP-side concern: a shed already has a decided
  // destination (`plannedShedTarget`), so there is no unknown step to seed.
  if (intent.plannedShedTarget !== undefined) return undefined;
  if (!isBinaryControlled(observed) || !getBinaryOn(observed)) return undefined;
  if (observed.steppedLoad?.reportedStepId !== undefined) return undefined;
  if (commandSession.reportedStepId !== undefined) return undefined;
  if (commandSession.hasPriorStepCommand) return undefined;
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
  currentFallback: ExecutableSteppedLoadState | undefined,
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
 * Step evidence for a device that prepares its current before it starts
 * (`activationOrder: 'current_before_start'`). Its executor enables charging
 * once the prepared rung reads as materialized, so that answer must come from
 * the device's own limit:
 *
 * - a report confirms a rung only when its watts are exactly that rung's. The
 *   producer reads an off-ladder limit as its NEAREST rung for planning, so with
 *   an owner ceiling of 6 A a retained 32 A limit reads as the 6 A rung;
 * - a confirmed command counts only while the device reports no positive limit.
 *   A vendor app can acknowledge a limit write it never applied, and a stopped
 *   charger that still reports another positive limit contradicts that ACK.
 *
 * Every other device keeps the nearest-rung reading (`toExecutableSteppedStepState`).
 */
const toPreparedCurrentStepState = (
  profile: ExecutableSteppedLoadIntent['steppedLoadProfile'],
  observed: ExecutableObservedSteppedLoadState | null | undefined,
  requestedStepId: string | undefined,
  confirmedCommandStepId: string | undefined,
): ExecutableSteppedStepState => {
  const nearest = toExecutableSteppedStepState(observed, requestedStepId, confirmedCommandStepId);
  const reportedStepId = observed?.reportedStepId;
  if (reportedStepId === undefined) return nearest;
  const reportedStep = getSteppedLoadStep(profile, reportedStepId);
  const reportsOff = isSteppedLoadOffStep(profile, reportedStepId);
  const exact = reportedStep !== null && (
    observed?.reportedStepPowerW === undefined
    || Math.round(observed.reportedStepPowerW) === Math.round(reportedStep.planningPowerW)
  );
  return {
    ...nearest,
    observedStep: exact ? nearest.observedStep : { kind: 'unknown' },
    confirmedCommandStepId: reportsOff && exact ? confirmedCommandStepId : undefined,
  };
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
  // the same test `buildSteppedCandidate` applies on the plan-device path
  // (`lib/plan/shedding/steppedCandidates.ts` — it rejects a zero draw before
  // pricing a rung).
  if (observed === null || observed === undefined || observed.currentDrawKw <= 0) {
    return undefined;
  }
  return {
    stepId: 'unknown',
    planningPowerW: Math.round(observed.currentDrawKw * 1000),
  };
};
