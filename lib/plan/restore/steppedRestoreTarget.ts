import type { SteppedLoadStep } from '../../../packages/contracts/src/types';
import { getSteppedLoadStep, sortSteppedLoadSteps } from '../../../packages/shared-domain/src/deviceControlProfiles';
import type { MeteredKind, SteppedPlanDevice } from '../planTypes';
import { resolveSurplusCeilingStepId, type PlanEngineState } from '../planState';
import { getSteppedLoadNextRestoreStep, resolveStepChangeKw } from '../planSteppedLoad';
import { resolveSteppedRestoreAttemptState } from '../planSteppedRestorePending';
import { isReserveAdmitted, resolveReserveAdmission } from '../admission';
import { isOffSteppedRestoreCandidate } from './devices';
import { canAdmitWithinBatch } from './batch';
import { computeRestoreRequirementKw } from './accounting';
import type { RestoreCycle, RestoreLoopState, SteppedRestoreNeed } from './types';

/**
 * The one command a stepped restore issues: the rung, the complete buffered
 * increase it commits, and how it was chosen. A `jump` past the adjacent rung
 * spends the shared batch allowance whether or not the device was limited; an
 * `adjacent` step does so only for a limited device, as ordinary admission.
 *
 * The first increase admitted in a cycle may jump as far as the full room
 * allows, like any single restore; the batch allowance (half the starting
 * room) bounds what a second or third device may add in the same cycle, when
 * several loads would arrive together. A charger at its lowest current with
 * room for its highest therefore climbs in one step and one restore cooldown,
 * not one rung per cooldown. With no limit on there is no room to share, so
 * there is no batch either, and the one increase the pass admits may jump to
 * the top of the ladder.
 */
export type SteppedRestoreTarget = {
  step: SteppedLoadStep;
  need: SteppedRestoreNeed;
  kind: 'adjacent' | 'jump';
};

/** Choose one command, charging the full jump against the shared batch allowance. */
export function resolveSteppedRestoreTarget(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice & MeteredKind,
  loop: RestoreLoopState,
): SteppedRestoreTarget | null {
  const isOff = isOffSteppedRestoreCandidate(dev);
  const adjacent = getSteppedLoadNextRestoreStep(dev);
  const pendingStep = isOff ? null : resolveOutstandingRestoreTarget(cycle, dev);
  if (pendingStep) return buildTarget(cycle, dev, pendingStep, adjacent);
  const fallback = admitStepUnderSurplusCeiling(dev, cycle.state, adjacent);
  if (!fallback) return null;
  const batch = cycle.batchState;
  if (isOff || !canConsiderJump(batch, loop)) return buildTarget(cycle, dev, fallback, adjacent);

  const steps = sortSteppedLoadSteps(dev.steppedLoadProfile.steps);
  const adjacentIndex = steps.findIndex((step) => step.id === fallback.id);
  for (const step of steps.slice(adjacentIndex + 1).reverse()) {
    const target = admitStepUnderSurplusCeiling(dev, cycle.state, step);
    if (!target) continue;
    const need = resolveSteppedRestoreNeed(cycle, dev, target);
    if (need.deltaKw <= 0 || !canAdmitJump(batch, loop, need.neededKw)) continue;
    if (isReserveAdmitted(resolveReserveAdmission(
      dev, loop.availableHeadroom, need.neededKw, cycle.headroomReserves,
    ))) return { step: target, need, kind: 'jump' };
  }
  return buildTarget(cycle, dev, fallback, adjacent);
}

// No headroom figure means no limit on any axis this device answers to, so the
// increase is bounded by nothing, as the first one under a limit is bounded by
// the full room. Without a batch the pass admits only that one increase. A batch
// disabled under a limit (grid import control, the exempt lane, a setpoint
// resume) keeps increases to the adjacent rung.
function canConsiderJump(batch: RestoreCycle['batchState'], loop: RestoreLoopState): boolean {
  return loop.availableHeadroom === null || (batch.enabled && batch.admittedCount < batch.maxDevices);
}

// The first admission of the cycle is bounded by the room itself (reserve
// admission below); later ones also by the shared batch allowance.
function canAdmitJump(batch: RestoreCycle['batchState'], loop: RestoreLoopState, neededKw: number): boolean {
  return loop.availableHeadroom === null || batch.admittedCount === 0 || canAdmitWithinBatch(batch, neededKw);
}

function buildTarget(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice & MeteredKind,
  step: SteppedLoadStep,
  adjacent: SteppedLoadStep | null,
): SteppedRestoreTarget {
  return {
    step,
    need: resolveSteppedRestoreNeed(cycle, dev, step),
    kind: step.id === adjacent?.id || isOffSteppedRestoreCandidate(dev) ? 'adjacent' : 'jump',
  };
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

/** Price the complete increase once, on the same rule as every restore. */
function resolveSteppedRestoreNeed(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice & MeteredKind,
  nextStep: SteppedLoadStep,
): SteppedRestoreNeed {
  const change = resolveStepChangeKw(dev, dev.selectedStepId, nextStep.id);
  if (change.direction !== 'up' || change.deltaKw <= 0) return { deltaKw: 0, neededKw: 0 };
  const { deltaKw } = change;
  return {
    deltaKw,
    neededKw: computeRestoreRequirementKw(deltaKw, cycle.state.actuation.lastDeviceShedMs[dev.id], cycle.timing.nowTs),
  };
}
