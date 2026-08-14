/**
 * Stepped-load shed-candidate construction, including WHICH rung of the ladder
 * the shed aims at.
 *
 * `getSteppedLoadShedTargetStep` answers "one rung down from here", and pricing
 * that single rung is not the same question as "does limiting this device
 * release power". `resolveSteppedLoadImmediateReliefKw` caps both sides of the
 * step delta by the current measurement, so the moment the measured draw sits at
 * or below the next rung's admission estimate the delta collapses to exactly
 * zero — for any from-step. Reading that zero as "limiting this frees nothing"
 * drops a device the meter shows drawing, when a deeper rung would release those
 * watts.
 *
 * That is what left a 2.9 kW water heater running through a 4.5-minute hard-cap
 * breach in production on 2026-08-05 (`inc_26449fb9`): its per-device
 * `measure_power` was stale at the `low`-step value while it ran at `max`, so
 * `max -> medium` priced at zero and the heater never became a shed candidate at
 * all — no cooldown, no penalty, no invariant, no log line.
 *
 * So `resolveSteppedShedRung` walks the ladder instead of sampling one rung and
 * returns the GENTLEST rung that actually releases power. It never invents
 * relief: every rung is priced by the same `resolveSteppedCandidatePower`, so
 * the answer stays bounded by what the meter reports. It only widens the search,
 * which keeps the module rule in `lib/plan/shedding/AGENTS.md` intact — a device
 * may only be selected when limiting it releases power.
 */
import type { SteppedLoadProfile, SteppedLoadStep } from '../../../packages/contracts/src/types';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice, ShedAction, SteppedPlanInputDevice } from '../planTypes';
import type { PendingBinaryCommandStore } from '../../observer/pendingBinaryCommands';
import {
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedCandidatePower,
  resolveSteppedLoadPlanningKw,
  resolveSteppedLoadSheddingTarget,
} from '../planSteppedLoad';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadLowestStep,
  getSteppedLoadNextLowerStep,
  getSteppedLoadOffStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../../utils/deviceControlProfiles';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { isNonSteppedDeviceRecovering } from '../planShedRecovery';
import { isPendingBinaryCommandActive } from '../planObservationPolicy';
import { buildTemperatureCandidate } from './candidateBuilders';
import type { ShedCandidateSkipRecorder } from './candidateSkipLog';
import { type ShedCandidate, type SheddingDeps } from './types';

type SteppedShedRung = {
  selectedStep: SteppedLoadStep;
  clampedTargetStep: SteppedLoadStep;
  hasUnconfirmedLowerDesiredStep: boolean;
  effectivePower: number;
};

/**
 * `no_reachable_step` and `no_relief` are deliberately distinct: the first means
 * the ladder offered nothing below the current position, so the caller still has
 * its prepared-binary-off and unknown-step fallbacks to try; the second means
 * rungs existed and none released power. Only the second is a genuine "this
 * device cannot help right now", and it carries the rungs tried so the skip is
 * reviewable in the log instead of silent.
 */
type SteppedShedRungResult =
  | { kind: 'rung'; rung: SteppedShedRung }
  | { kind: 'no_relief'; rungsTried: string[] }
  | { kind: 'no_reachable_step' };

/**
 * Ordered shed targets from `initialTargetStep` downwards, gentlest first.
 *
 * **Only a `turn_off` device descends**, and the reason is that the planner does
 * not get to name the step the executor commands. Materialization recomputes it
 * from the device alone (`resolveSteppedLoadDirectShedStepId`, reached from
 * `planDevicesBase`); the candidate's `toStepId` never crosses over — only
 * `shedSet` membership does. That resolver answers:
 *
 *   - `turn_off`  → the off step. Whatever rung is credited here, the executor
 *     turns the device off, so delivered relief is the device's whole draw and
 *     the credit can only be an under-estimate. Safe to descend.
 *   - `set_step`  → the ADJACENT rung, recomputed with `getSteppedLoadShedTargetStep`.
 *     Crediting a deeper rung would promise relief the executor never delivers:
 *     selection would decrement its deficit by a step-down that is then not
 *     commanded, treat the breach as covered, and skip the device that could
 *     actually have helped. Strictly worse than not offering the candidate.
 *
 * So the invariant this function protects is **credited relief <= delivered
 * relief**. If materialization ever honours the planner's chosen `toStepId`, a
 * `set_step` descent becomes safe and this restriction can be lifted (TODO).
 *
 * Within the `turn_off` ladder: `getSteppedLoadNextLowerStep` floors at the
 * lowest ACTIVE step, so the off step is not on it and has to be appended.
 */
function buildSteppedShedDescentTargets(params: {
  profile: SteppedLoadProfile;
  initialTargetStep: SteppedLoadStep;
  shedAction: 'turn_off' | 'set_step';
}): SteppedLoadStep[] {
  const { profile, initialTargetStep, shedAction } = params;
  if (shedAction !== 'turn_off') return [initialTargetStep];
  const targets: SteppedLoadStep[] = [initialTargetStep];
  const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
  if (lowestActiveStep) {
    let cursor = initialTargetStep;
    // Bounded by the profile's own step count — the ladder cannot be longer than
    // the steps it is built from, so the walk cannot outrun the profile.
    for (let index = 0; index < profile.steps.length; index += 1) {
      const next = getSteppedLoadNextLowerStep({
        profile,
        stepId: cursor.id,
        floorStepId: lowestActiveStep.id,
      });
      if (!next || next.id === cursor.id) break;
      targets.push(next);
      cursor = next;
    }
  }
  const offStep = getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile);
  if (offStep && !targets.some((step) => step.id === offStep.id)) targets.push(offStep);
  return targets;
}

export function resolveSteppedShedRung(params: {
  device: PlanInputDevice;
  profile: SteppedLoadProfile;
  initialTargetStep: SteppedLoadStep | null;
  shedAction: 'turn_off' | 'set_step';
}): SteppedShedRungResult {
  const { device, profile, initialTargetStep, shedAction } = params;
  if (!initialTargetStep) return { kind: 'no_reachable_step' };
  const targets = buildSteppedShedDescentTargets({ profile, initialTargetStep, shedAction });
  const rungsTried: string[] = [];
  for (const targetStep of targets) {
    const steppedTarget = resolveSteppedLoadSheddingTarget({ device, targetStep });
    // A rung that resolves to the device's own current step is not a step down.
    if (!steppedTarget) continue;
    const { selectedStep, clampedTargetStep, hasUnconfirmedLowerDesiredStep } = steppedTarget;
    // A pending lower desired step clamps every rung to the same place; price it
    // once rather than reporting the same attempt several times.
    if (rungsTried.includes(clampedTargetStep.id)) continue;
    rungsTried.push(clampedTargetStep.id);
    const effectivePower = resolveSteppedCandidatePower(device, selectedStep, clampedTargetStep);
    if (effectivePower <= 0) continue;
    return {
      kind: 'rung',
      rung: { selectedStep, clampedTargetStep, hasUnconfirmedLowerDesiredStep, effectivePower },
    };
  }
  if (rungsTried.length === 0) return { kind: 'no_reachable_step' };
  return { kind: 'no_relief', rungsTried };
}

type SteppedCandidateParams = {
  device: PlanInputDevice;
  devices: PlanInputDevice[];
  priority: number;
  recentlyRestored: boolean;
  state: PlanEngineState;
  getShedBehavior: SheddingDeps['getShedBehavior'];
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  recorder?: ShedCandidateSkipRecorder;
};

export function buildSteppedCandidate(params: SteppedCandidateParams): ShedCandidate | null {
  const { device, getShedBehavior, recorder } = params;
  if (!isSteppedLoadDevice(device)) return null;
  // `currentDrawKw === 0` means the device is drawing nothing. The reason code
  // deliberately does NOT say "measured": how the producer knows is not this
  // layer's business, and a consumer that started caring would be re-deriving.
  if (device.currentDrawKw === 0) {
    recorder?.record({ device, reasonCode: 'stepped_zero_draw' });
    return null;
  }
  const shedBehavior = getShedBehavior(device.id);
  if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
    return buildSteppedTemperatureCandidate(params, shedBehavior.temperature);
  }
  return buildSteppedStepDownCandidate(
    params,
    shedBehavior.action === 'set_step' ? 'set_step' : 'turn_off',
  );
}

/** A stepped device whose configured shed behaviour lowers a setpoint instead of a step. */
function buildSteppedTemperatureCandidate(
  params: SteppedCandidateParams,
  shedTemperature: number,
): ShedCandidate | null {
  const { device, priority, recentlyRestored, state, recorder } = params;
  const target = device.targets?.[0];
  if (!target?.id) {
    recorder?.record({ device, reasonCode: 'no_temperature_target' });
    return null;
  }
  return buildTemperatureCandidate({
    device,
    priority,
    recentlyRestored,
    shedTemperature,
    targetCapabilityId: target.id,
    targetCapability: target,
    pendingTargetCommands: state.pendingTargetCommands,
    recorder,
  });
}

function buildSteppedStepDownCandidate(
  params: SteppedCandidateParams,
  shedAction: 'turn_off' | 'set_step',
): ShedCandidate | null {
  const { device, devices, priority, recentlyRestored, state, recorder } = params;
  if (!isSteppedLoadDevice(device)) return null;
  const profile = device.steppedLoadProfile;
  const targetStep = resolveSteppedShedTargetStep({
    device,
    devices,
    state,
    shedBehaviorAction: shedAction,
    effectiveCurrentStepId: resolveEffectiveCurrentStepIdForSteppedShedding(device),
  });
  // Walk the ladder rather than pricing only the next rung down: a measurement
  // that lags a step-up prices the adjacent rung at exactly zero relief, which
  // would drop a device the meter shows drawing.
  const rungResult = resolveSteppedShedRung({ device, profile, initialTargetStep: targetStep, shedAction });
  if (rungResult.kind === 'no_reachable_step') {
    return buildSteppedNoRungFallbackCandidate({ params, shedAction, targetStep });
  }
  if (rungResult.kind === 'no_relief') {
    recorder?.record({ device, reasonCode: 'zero_step_relief', rungsTried: rungResult.rungsTried });
    return null;
  }
  const { selectedStep, clampedTargetStep, hasUnconfirmedLowerDesiredStep, effectivePower } = rungResult.rung;
  return {
    ...device,
    kind: 'stepped',
    priority,
    recentlyRestored,
    unconfirmedRelief: hasUnconfirmedLowerDesiredStep,
    effectivePower,
    fromStepId: selectedStep.id,
    toStepId: clampedTargetStep.id,
    preemptiveStepDown: isPreemptiveStepReduction({ profile, selectedStep, clampedTargetStep }),
  };
}

/**
 * True only for a genuine step REDUCTION — one that leaves the device running at
 * a lower step.
 *
 * This drives candidate ordering, so it is load-bearing twice over:
 * `sortCandidates` places a preemptive candidate ahead of every other candidate
 * regardless of priority, and `shouldStopAfterCandidate` ends the selection loop
 * right after one. A descent that lands on the off step is a full turn-off, and
 * `sortCandidates` is explicit that those follow normal priority ordering —
 * marking one preemptive would jump the queue and then strand the rest of the
 * deficit for a whole cycle.
 *
 * Reading the TARGET rather than only the from-step also covers a pre-existing
 * corner: a pending desired step of `off` clamps the target to `off` while the
 * confirmed position is still high.
 */
function isPreemptiveStepReduction(params: {
  profile: SteppedLoadProfile;
  selectedStep: SteppedLoadStep;
  clampedTargetStep: SteppedLoadStep;
}): boolean {
  const { profile, selectedStep, clampedTargetStep } = params;
  if (isSteppedLoadOffStep(profile, clampedTargetStep.id)) return false;
  const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
  return Boolean(
    lowestActiveStep
    && selectedStep.id !== lowestActiveStep.id
    && selectedStep.planningPowerW > lowestActiveStep.planningPowerW,
  );
}

/**
 * The ladder offered nothing below the current position. One shape can still
 * shed: a device already parked at the shed target that finishes with a binary
 * off. (The old measured-fallback for a device with no known step is gone —
 * the effective step is producer-guaranteed for every stepped device.)
 */
function buildSteppedNoRungFallbackCandidate(args: {
  params: SteppedCandidateParams;
  shedAction: 'turn_off' | 'set_step';
  targetStep: ReturnType<typeof getSteppedLoadShedTargetStep>;
}): ShedCandidate | null {
  const { params, shedAction, targetStep } = args;
  const { device, priority, recentlyRestored, pendingBinaryCommandStore, recorder } = params;
  if (!isSteppedLoadDevice(device)) return null;
  const preparedBinaryOffCandidate = buildPreparedSteppedBinaryOffCandidate({
    device,
    steppedProfile: device.steppedLoadProfile,
    targetStep,
    priority,
    recentlyRestored,
    shedAction,
    pendingBinaryCommandStore,
  });
  if (preparedBinaryOffCandidate) return preparedBinaryOffCandidate;
  recorder?.record({ device, reasonCode: 'no_lower_step_reachable' });
  return null;
}

function resolveEffectiveCurrentStepIdForSteppedShedding(device: SteppedPlanInputDevice): string | undefined {
  // Advance past a pending step-down rather than re-issuing the same command.
  // Only use the pending step when it is lower (a shed, not a restore).
  const pendingIsLower = device.stepCommandPending
    && device.desiredStepId
    && device.desiredStepId !== device.selectedStepId
    && resolveSteppedLoadPlanningKw(device, device.desiredStepId)
      < resolveSteppedLoadPlanningKw(device, device.selectedStepId);
  return pendingIsLower ? device.desiredStepId : device.selectedStepId;
}

function buildPreparedSteppedBinaryOffCandidate(params: {
  device: SteppedPlanInputDevice;
  steppedProfile: SteppedLoadProfile;
  targetStep: ReturnType<typeof getSteppedLoadShedTargetStep>;
  priority: number;
  recentlyRestored: boolean;
  shedAction: 'turn_off' | 'set_step';
  pendingBinaryCommandStore: PendingBinaryCommandStore;
}): ShedCandidate | null {
  const {
    device,
    steppedProfile,
    targetStep,
    priority,
    recentlyRestored,
    shedAction,
    pendingBinaryCommandStore,
  } = params;
  if (
    shedAction !== 'turn_off'
    || !isBinaryPlanDevice(device)
    || targetStep?.id !== device.selectedStepId
  ) {
    return null;
  }
  const selectedStep = getSteppedLoadStep(steppedProfile, device.selectedStepId);
  if (!selectedStep || isSteppedLoadOffStep(steppedProfile, selectedStep.id)) return null;
  const effectivePower = device.currentDrawKw;
  if (effectivePower <= 0) return null;
  // Raw read: activeness is computed here with the device's communication
  // model, so `peek` (not `get`) preserves the prior field-read behaviour.
  const pendingEntry = pendingBinaryCommandStore.peek(device.id);
  const pendingBinary = isPendingBinaryCommandActive({
    pending: pendingEntry,
  }) ? pendingEntry : undefined;
  return {
    ...device,
    kind: 'stepped',
    priority,
    recentlyRestored,
    unconfirmedRelief: pendingBinary?.desired === false,
    effectivePower,
    fromStepId: selectedStep.id,
    toStepId: selectedStep.id,
    preemptiveStepDown: false,
  };
}

function resolveSteppedShedTargetStep(params: {
  device: PlanInputDevice;
  devices: PlanInputDevice[];
  state: Pick<PlanEngineState, 'shedDecidedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>;
  shedBehaviorAction: ShedAction;
  effectiveCurrentStepId?: string;
}): SteppedLoadStep | null {
  const { device, devices, state, shedBehaviorAction, effectiveCurrentStepId } = params;
  const forceLowestActiveStep = shedBehaviorAction === 'set_step'
    && devices.some((candidate) => candidate.id !== device.id && isNonSteppedDeviceRecovering(candidate, state));
  if (forceLowestActiveStep) {
    if (!isSteppedLoadDevice(device)) return null;
    return getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  }
  return getSteppedLoadShedTargetStep({
    device,
    shedAction: shedBehaviorAction === 'set_step' ? 'set_step' : 'turn_off',
    currentDesiredStepId: effectiveCurrentStepId,
  });
}
