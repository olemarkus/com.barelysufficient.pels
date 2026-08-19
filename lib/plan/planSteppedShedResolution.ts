import type { PlanEngineState } from './planState';
import type { PlanInputDevice, ShedAction, ShedBehavior } from './planTypes';
import { isNonSteppedDeviceRecovering } from './planShedRecovery';
import {
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedLoadPlanningKw,
} from './planSteppedLoad';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadLowestStep,
  getSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';

/**
 * The step this cycle's shed parks a stepped device at.
 *
 * The answer is the SHEDDING PLANNER's, handed over as `shedStepTargets`
 * (`SheddingPlan`) and returned here unchanged. That is the whole point: the
 * rung the candidate was priced at is the rung the executor commands, so
 * credited relief equals delivered relief. This used to recompute the step from
 * the device alone and answer the off step for every `turn_off` device, which
 * made the planner's chosen rung inert — it decided candidacy and nothing else,
 * and every `turn_off` shed shipped as a full cut.
 *
 * The configured shed behaviour is only the FLOOR — the deepest this cycle may
 * go, "worst case, turn off" / "worst case, the lowest active step" — so it is
 * the fallback for a device with no planner decision, never an override of one.
 * That fallback is reached by a shed decided outside the shedding planner (a
 * later stage flipping `plannedState`) and by a prepared-binary-off candidate,
 * whose relief is the binary off rather than a step change.
 *
 * Deliberately NOT re-derived here any more: the forced-lowest-active clamp and
 * the pending-lower-step clamp. `resolveSteppedShedTargetStep` and
 * `resolveSteppedLoadSheddingTarget` already applied both when the candidate was
 * priced, so repeating them here could only produce a second, disagreeing
 * answer. `resolveSteppedShedHypotheticalStepId` below keeps them for the one
 * caller that has no decision to honour.
 */
export function resolveSteppedLoadDirectShedStepId(params: {
  dev: PlanInputDevice;
  shedBehavior: ShedBehavior;
  shouldShed: boolean;
  /** The rung the shedding planner priced this shed at, when it chose one. */
  plannedShedStepId: string | undefined;
}): string | undefined {
  const {
    dev, shedBehavior, shouldShed, plannedShedStepId,
  } = params;
  if (!shouldShed || !isSteppedLoadDevice(dev)) return undefined;
  if (plannedShedStepId !== undefined) return plannedShedStepId;
  return resolveShedBehaviorFloorStepId(dev, shedBehavior.action);
}

/**
 * The deepest step the configured behaviour permits — `turn_off`'s off step,
 * `set_step`'s lowest active step. Read only when no rung was decided.
 */
function resolveShedBehaviorFloorStepId(
  dev: PlanInputDevice,
  action: ShedAction,
): string | undefined {
  if (!isSteppedLoadDevice(dev)) return undefined;
  const profile = dev.steppedLoadProfile;
  if (action === 'turn_off') {
    return (getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile))?.id;
  }
  if (action !== 'set_step') return undefined;
  return getSteppedLoadLowestActiveStep(profile)?.id;
}

/**
 * Where a `set_step` shed WOULD land this device, recomputed from the device
 * alone.
 *
 * Its one caller (`isPhantomSetStepShed`) runs as a pre-pass, before selection
 * has decided anything, and asks a hypothetical: would shedding this device
 * actually move it? So it has no planner answer to honour and must derive one —
 * including the forced-lowest-active clamp and the pending-lower-step clamp,
 * which the candidate builder applies on the real path.
 */
export function resolveSteppedShedHypotheticalStepId(params: {
  dev: PlanInputDevice;
  devices: PlanInputDevice[];
  state: PlanEngineState;
  shedBehavior: ShedBehavior;
  currentDesiredStepId?: string;
}): string | undefined {
  const {
    dev, devices, state, shedBehavior, currentDesiredStepId,
  } = params;
  if (!isSteppedLoadDevice(dev)) return undefined;
  if (shedBehavior.action !== 'set_step') return undefined;
  if (shouldForceLowestActiveStep({ dev, devices, state, shedBehaviorAction: shedBehavior.action })) {
    return getSteppedLoadLowestActiveStep(dev.steppedLoadProfile)?.id;
  }
  const targetStep = getSteppedLoadShedTargetStep({
    device: dev,
    shedAction: 'set_step',
    currentDesiredStepId,
  });
  return targetStep?.id;
}

export function resolveSteppedShedCurrentDesiredStepId(dev: PlanInputDevice): string | undefined {
  if (!isSteppedLoadDevice(dev)) return undefined;
  if (!dev.stepCommandPending || !dev.desiredStepId) return dev.selectedStepId;
  const desiredKw = resolveSteppedLoadPlanningKw(dev, dev.desiredStepId);
  const selectedKw = resolveSteppedLoadPlanningKw(dev, dev.selectedStepId);
  return desiredKw < selectedKw ? dev.desiredStepId : dev.selectedStepId;
}

function shouldForceLowestActiveStep(params: {
  dev: PlanInputDevice;
  devices: PlanInputDevice[];
  state: Pick<PlanEngineState, 'shedDecidedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>;
  shedBehaviorAction: ShedAction;
}): boolean {
  const { dev, devices, state, shedBehaviorAction } = params;
  return shedBehaviorAction === 'set_step'
    && devices.some((candidate) => candidate.id !== dev.id && isNonSteppedDeviceRecovering(candidate, state));
}
