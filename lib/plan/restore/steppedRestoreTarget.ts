import type { SteppedLoadStep } from '../../../packages/contracts/src/types';
import { getSteppedLoadStep, sortSteppedLoadSteps } from '../../../packages/shared-domain/src/deviceControlProfiles';
import type { MeteredKind, SteppedPlanDevice } from '../planTypes';
import { resolveSurplusCeilingStepId, type PlanEngineState } from '../planState';
import { getSteppedLoadNextRestoreStep, resolveStepChangeKw } from '../planSteppedLoad';
import { resolveSteppedRestoreAttemptState } from '../planSteppedRestorePending';
import { isReserveAdmitted, resolveReserveAdmission } from '../admission';
import { isOffSteppedRestoreCandidate } from './devices';
import { canAdmitWithinBatch } from './batch';
import { computeRestoreBufferKw } from './accounting';
import type { RestoreCycle, RestoreLoopState, SteppedRestoreNeed } from './types';

/** Choose one command, charging the full jump against the shared batch allowance. */
export function resolveSteppedRestoreTarget(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice & MeteredKind,
  loop: RestoreLoopState,
): SteppedLoadStep | null {
  const isOff = isOffSteppedRestoreCandidate(dev);
  const pendingStep = isOff ? null : resolveOutstandingRestoreTarget(cycle, dev);
  if (pendingStep) return pendingStep;
  const adjacent = getSteppedLoadNextRestoreStep(dev);
  const fallback = admitStepUnderSurplusCeiling(dev, cycle.state, adjacent);
  const batch = cycle.batchState;
  if (!fallback || isOff || !batch.enabled
    || batch.admittedCount >= batch.maxDevices) return fallback;

  const steps = sortSteppedLoadSteps(dev.steppedLoadProfile.steps);
  const adjacentIndex = steps.findIndex((step) => step.id === fallback.id);
  for (const step of steps.slice(adjacentIndex + 1).reverse()) {
    const target = admitStepUnderSurplusCeiling(dev, cycle.state, step);
    if (!target) continue;
    const need = resolveSteppedRestoreNeed(dev, target);
    if (need.deltaKw <= 0 || !canAdmitWithinBatch(batch, need.neededKw)) continue;
    if (isReserveAdmitted(resolveReserveAdmission(
      dev, loop.availableHeadroom, need.neededKw, cycle.headroomReserves,
    ))) return target;
  }
  return fallback;
}

// Admission can now choose a different rung as headroom changes. Qualify the
// command already in flight against its own target, not that newly chosen rung.
function resolveOutstandingRestoreTarget(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice & MeteredKind,
): SteppedLoadStep | null {
  const target = getSteppedLoadStep(dev.steppedLoadProfile, dev.lastDesiredStepId);
  if (!target || resolveStepChangeKw(dev, dev.selectedStepId, target.id).direction === 'down') return null;
  if (!admitStepUnderSurplusCeiling(dev, cycle.state, target)) return null;
  const attempt = resolveSteppedRestoreAttemptState(
    dev, target.id, cycle.timing.nowTs,
    cycle.state.actuation.lastDeviceRestoreMs[dev.id], cycle.timing.measurementTs,
  );
  return attempt ? target : null;
}

// Restore admission must respect the solar allocation even when grid headroom
// would fund a higher rung. Boost bypasses that ceiling, as on the keep path.
function admitStepUnderSurplusCeiling(
  dev: SteppedPlanDevice,
  state: PlanEngineState,
  nextStep: SteppedLoadStep | null,
): SteppedLoadStep | null {
  if (!nextStep) return null;
  if (!dev.surplusTracking || dev.boostActive) return nextStep;
  const ceilingStepId = resolveSurplusCeilingStepId(state, dev.id);
  if (ceilingStepId === undefined) return nextStep;
  const ceilingStep = getSteppedLoadStep(dev.steppedLoadProfile, ceilingStepId);
  if (!ceilingStep) return nextStep;
  return nextStep.planningPowerW <= ceilingStep.planningPowerW ? nextStep : null;
}

/** Price the complete increase once, including its restore buffer. */
export function resolveSteppedRestoreNeed(
  dev: SteppedPlanDevice & MeteredKind,
  nextStep: SteppedLoadStep | null,
): SteppedRestoreNeed {
  if (!nextStep) return { deltaKw: 0, neededKw: 0 };
  const change = resolveStepChangeKw(dev, dev.selectedStepId, nextStep.id);
  if (change.direction !== 'up' || change.deltaKw <= 0) return { deltaKw: 0, neededKw: 0 };
  const { deltaKw } = change;
  return { deltaKw, neededKw: deltaKw + computeRestoreBufferKw(deltaKw) };
}
