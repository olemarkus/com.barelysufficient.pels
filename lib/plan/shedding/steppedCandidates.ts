/**
 * Stepped-load shed-candidate construction, including WHICH rung of the ladder
 * the shed aims at.
 *
 * `getSteppedLoadShedTargetStep` answers "one rung down from here", and pricing
 * that single rung is not the same question as "does limiting this device
 * release power". A rung whose admission estimate sits at or above the measured
 * draw prices at exactly zero, and reading that zero as "limiting this frees
 * nothing" drops a device the meter shows drawing, when a deeper rung would
 * release those watts.
 *
 * That is what left a 2.9 kW water heater running through a 4.5-minute hard-cap
 * breach in production on 2026-08-05 (`inc_26449fb9`): its per-device
 * `measure_power` was stale at the `low`-step value while it ran at `max`, so
 * `max -> medium` priced at zero and the heater never became a shed candidate at
 * all — no cooldown, no penalty, no invariant, no log line.
 *
 * So `resolveSteppedShedLadder` prices the whole ladder instead of sampling one
 * rung, and offers every step down that releases power. It never invents relief:
 * every rung goes through the same `resolveStepChangeKw`, whose descent arm is
 * bounded by the meter, so the answer stays bounded by what the device is
 * actually drawing. It only widens the search, which keeps the module rule in
 * `lib/plan/shedding/AGENTS.md` intact — a device may only be selected when
 * limiting it releases power.
 *
 * WHICH of those rungs a shed takes is decided when the candidate is spent, by
 * `chooseShedRung` from `selection.ts`, against the deficit still open at that
 * point. Deciding it here would size every candidate against the cycle's opening
 * deficit and over-shoot by whatever earlier picks already covered.
 */
import type { SteppedLoadProfile, SteppedLoadStep } from '../../../packages/contracts/src/types';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice, ShedAction, SteppedPlanInputDevice } from '../planTypes';
import type { PendingBinaryCommandStore } from '../../observer/pendingBinaryCommands';
import {
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveStepChangeKw,
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
import { buildTemperatureCandidate } from './candidateBuilders';
import type { ShedCandidateSkipRecorder } from './candidateSkipLog';
import { type PricedShedRung, type ShedCandidate, type SheddingDeps } from './types';

/**
 * `no_reachable_step` and `no_relief` are deliberately distinct: the first means
 * the ladder offered nothing below the current position, so the caller still has
 * its prepared-binary-off and unknown-step fallbacks to try; the second means
 * rungs existed and none released power. Only the second is a genuine "this
 * device cannot help right now", and it carries the rungs tried so the skip is
 * reviewable in the log instead of silent.
 */
type SteppedShedLadderResult =
  | {
    kind: 'ladder';
    fromStepId: string;
    rungs: PricedShedRung[];
    /** Device-level, not per-rung — see `resolveUnconfirmedLowerDesiredStep`. */
    unconfirmedRelief: boolean;
  }
  | { kind: 'no_relief'; rungsTried: string[] }
  | { kind: 'no_reachable_step' };

/**
 * Ordered shed targets from `initialTargetStep` downwards, gentlest first.
 *
 * **Both behaviours descend; they differ only in where the descent stops.** A
 * `set_step` shed ends at the deepest rung that is not OFF-CLASSIFIED — the
 * owner's "lower it" means as far down the ladder as the deficit needs, and
 * never off. A `turn_off` shed walks the same rungs and then gets the off step
 * appended.
 *
 * "Not off-classified" is deliberately not "the lowest rung with power". The
 * walk floors on `getSteppedLoadLowestActiveStep`, which tests `planningPowerW >
 * 0` alone, while `isSteppedLoadOffStep` also counts a step NAMED `off`; on a
 * hand-configured profile those two answers differ, so the `set_step` floor is
 * taken from the off rule and not from the floor the walk happened to use.
 *
 * `set_step` used to be offered `initialTargetStep` alone, and that was a
 * pricing constraint rather than a product one: materialization recomputed the
 * step from the device, so crediting a deeper rung would have decremented the
 * deficit by relief the executor never commanded. That is no longer how it
 * works — `resolveSteppedLoadDirectShedStepId` takes `plannedShedStepId`, the
 * rung this module priced the shed at, and returns it unchanged. Credited relief
 * equals delivered relief for both behaviours, so the widened ladder cannot
 * over-credit.
 *
 * Widening the ladder does not deepen a shed on its own: which rung is taken is
 * still `chooseShedRung` at spend time, gentlest one that covers the remaining
 * deficit.
 */
function buildSteppedShedDescentTargets(params: {
  profile: SteppedLoadProfile;
  initialTargetStep: SteppedLoadStep;
  shedAction: 'turn_off' | 'set_step';
}): SteppedLoadStep[] {
  const { profile, initialTargetStep, shedAction } = params;
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
  // The off step is `turn_off`'s alone, and for `set_step` "not off" has to be
  // asked of `isSteppedLoadOffStep` rather than inferred from the floor the walk
  // used. The two rules disagree: `getSteppedLoadLowestActiveStep` floors on
  // `planningPowerW > 0` and ignores the step's NAME, while the off rule also
  // counts a step called `off`. A hand-configured `{ id: 'off', planningPowerW:
  // 1200 }` satisfies the first and fails the second, so the walk floors ON that
  // rung and a deficit large enough to want it would have `chooseShedRung`
  // command the one step this behaviour promises never to reach. Filtering here
  // keeps the single authority at this call site; the two helpers keep their
  // meanings for every other caller.
  if (shedAction !== 'turn_off') {
    return targets.filter((step) => !isSteppedLoadOffStep(profile, step.id));
  }
  const offStep = getSteppedLoadOffStep(profile) ?? getSteppedLoadLowestStep(profile);
  if (offStep && !targets.some((step) => step.id === offStep.id)) targets.push(offStep);
  return targets;
}

/**
 * Prices the whole ladder rather than one rung: every reachable step down from
 * the device's current position, gentlest first, each with the relief it
 * releases. Rungs that release nothing are dropped, so the result is exactly
 * "the ways this device can help, cheapest first".
 *
 * It stays bounded by the meter: every rung is priced by `resolveStepChangeKw`,
 * whose descent arm bounds the before-side at the MEASURED draw, so the deepest
 * rung buys what the meter says the device is pulling and no more. Not what the
 * reported step's model says — that is the half which can be stale.
 *
 * Which rung a shed actually takes is NOT decided here — `selectShedDevices`
 * decides it, against the deficit still open when this candidate's turn comes.
 * See `chooseShedRung`.
 */
export function resolveSteppedShedLadder(params: {
  device: PlanInputDevice;
  profile: SteppedLoadProfile;
  initialTargetStep: SteppedLoadStep | null;
  shedAction: 'turn_off' | 'set_step';
}): SteppedShedLadderResult {
  const { device, profile, initialTargetStep, shedAction } = params;
  if (!initialTargetStep) return { kind: 'no_reachable_step' };
  const targets = buildSteppedShedDescentTargets({ profile, initialTargetStep, shedAction });
  const rungsTried: string[] = [];
  const rungs: PricedShedRung[] = [];
  let fromStepId: string | undefined;
  let unconfirmedRelief = false;
  for (const targetStep of targets) {
    const steppedTarget = resolveSteppedLoadSheddingTarget({ device, targetStep });
    // A rung that resolves to the device's own current step is not a step down.
    if (!steppedTarget) continue;
    const { selectedStep, clampedTargetStep, hasUnconfirmedLowerDesiredStep } = steppedTarget;
    // A pending lower desired step clamps every rung to the same place; price it
    // once rather than reporting the same attempt several times.
    if (rungsTried.includes(clampedTargetStep.id)) continue;
    rungsTried.push(clampedTargetStep.id);
    fromStepId = selectedStep.id;
    unconfirmedRelief = hasUnconfirmedLowerDesiredStep;
    const change = resolveStepChangeKw(device, selectedStep.id, clampedTargetStep.id);
    // A rung the clamp turned into a climb (or into standing still) is not a
    // way to shed. Skipping it explicitly beats letting it price at zero and
    // reading that as "this device frees nothing".
    if (change.direction !== 'down' || change.deltaKw <= 0) continue;
    rungs.push({ toStepId: clampedTargetStep.id, reliefKw: change.deltaKw });
  }
  if (rungs.length > 0 && fromStepId !== undefined) {
    return { kind: 'ladder', fromStepId, rungs, unconfirmedRelief };
  }
  if (rungsTried.length === 0) return { kind: 'no_reachable_step' };
  return { kind: 'no_relief', rungsTried };
}

/**
 * The rung a shed of `neededKw` aims at: the **gentlest rung whose priced relief
 * covers it**, and when no rung covers it, the one with the most priced relief
 * (the deepest, since relief does not shrink as the ladder descends).
 *
 * Sizing the rung to what is needed is the point, in both directions. Answering
 * a 3.77 kW deficit with a 1.01 kW step-down leaves the house over the limit and
 * buys another cycle of the same decision. Answering a 1 kW remainder with a rung
 * sized for the 3 kW the cycle opened with cuts two kW of load for nothing — and
 * with two stepped devices eligible in one cycle, a 3 kW deficit was answered
 * with 5 kW of shedding.
 *
 * That is why `neededKw` is the deficit still open when this candidate's turn
 * comes (`selection.ts`), not the cycle's opening deficit. The one place the
 * opening deficit is still the right question is candidate ORDERING, which
 * happens before any spending: `preemptiveStepDown` asks this same question
 * against it — "if this candidate went first, would it still be running?".
 *
 * `neededKw` must be a measured kW quantity: it is fed `deficitKw` and the
 * remainder derived from it, never the severity `needed`, which is
 * `Number.POSITIVE_INFINITY` in an exhausted hour and would leave "covers the
 * deficit" with no possible answer.
 */
export function chooseShedRung(
  rungs: readonly PricedShedRung[],
  neededKw: number,
): PricedShedRung | null {
  let deepestRung: PricedShedRung | null = null;
  for (const rung of rungs) {
    // The ladder is ordered gentlest-first, so the first rung that covers what
    // is needed is the gentlest one that does.
    if (rung.reliefKw >= neededKw) return rung;
    // Ties keep the gentler rung: a deeper cut that frees no more watts is a
    // deeper cut for nothing.
    if (!deepestRung || rung.reliefKw > deepestRung.reliefKw) deepestRung = rung;
  }
  return deepestRung;
}

type SteppedCandidateParams = {
  device: PlanInputDevice;
  devices: PlanInputDevice[];
  priority: number;
  recentlyRestored: boolean;
  /** The deficit this shed cycle has to close, in kW. Sizes the chosen rung. */
  neededKw: number;
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
  if (shedBehavior.action === 'set_temperature') {
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
  const { device, devices, priority, recentlyRestored, neededKw, state, recorder } = params;
  if (!isSteppedLoadDevice(device)) return null;
  const profile = device.steppedLoadProfile;
  const targetStep = resolveSteppedShedTargetStep({
    device,
    devices,
    state,
    shedBehaviorAction: shedAction,
    effectiveCurrentStepId: resolveEffectiveCurrentStepIdForSteppedShedding(device),
  });
  // Price the whole ladder rather than only the next rung down: a measurement
  // that lags a step-up prices the adjacent rung at exactly zero relief, which
  // would drop a device the meter shows drawing, and an adjacent rung worth a
  // fraction of the deficit answers a breach it cannot close.
  const ladder = resolveSteppedShedLadder({
    device,
    profile,
    initialTargetStep: targetStep,
    shedAction,
  });
  if (ladder.kind === 'no_reachable_step') {
    return buildSteppedNoRungFallbackCandidate({ params, shedAction, targetStep });
  }
  if (ladder.kind === 'no_relief') {
    recorder?.record({ device, reasonCode: 'zero_step_relief', rungsTried: ladder.rungsTried });
    return null;
  }
  return {
    ...device,
    kind: 'stepped',
    priority,
    recentlyRestored,
    unconfirmedRelief: ladder.unconfirmedRelief,
    // Everything this device can free — the deepest priced rung, which is a
    // property of the device and the meter, not of when this candidate is
    // spent. Ranking and the reducible-load stats both need a stable number.
    effectivePower: chooseShedRung(ladder.rungs, Number.POSITIVE_INFINITY)?.reliefKw ?? 0,
    fromStepId: ladder.fromStepId,
    rungs: ladder.rungs,
    preemptiveStepDown: isPreemptiveStepReduction({ profile, rungs: ladder.rungs, neededKw }),
  };
}

/**
 * True when taking this candidate FIRST would leave the device running at a
 * lower step rather than turning it off.
 *
 * This drives candidate ordering: `sortCandidates` places a preemptive candidate
 * ahead of every other candidate regardless of priority, so the cheapest credit
 * — a device that can answer the deficit without spending a whole load — is
 * taken first.
 *
 * It has to be a STABLE key. The rung a shed actually takes is chosen at spend
 * time, against whatever deficit is left by then, so it is not available to a
 * comparator and would make the sort depend on its own outcome. The two inputs
 * here are both fixed for the cycle — the device's priced ladder and the
 * cycle's opening deficit — and "first" is exactly the case where the remainder
 * IS the opening deficit, so ranking on it is not an approximation of the
 * question, it is the question.
 *
 * Deliberately NOT the looser "does this device have any lower rung at all".
 * That ranks a device ahead of the owner's priority order on the strength of a
 * reduction it will not end up taking: a 1 kW stepped load against a 3 kW
 * deficit would sort first, find no rung that covers, take its off rung anyway,
 * and leave the binary load the owner ranked as sheddable-first shed as well —
 * a device turned off out of order AND an over-shed.
 *
 * A descent that lands on the off step is a full turn-off, and those follow
 * normal priority ordering (`sortCandidates`). Reading the chosen TARGET rather
 * than only the from-step also covers a pre-existing corner: a pending desired
 * step of `off` clamps every rung to `off` while the confirmed position is still
 * high.
 */
function isPreemptiveStepReduction(params: {
  profile: SteppedLoadProfile;
  rungs: readonly PricedShedRung[];
  neededKw: number;
}): boolean {
  const { profile, rungs, neededKw } = params;
  const firstPickRung = chooseShedRung(rungs, neededKw);
  if (!firstPickRung) return false;
  return !isSteppedLoadOffStep(profile, firstPickRung.toStepId);
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
  return {
    ...device,
    kind: 'stepped',
    priority,
    recentlyRestored,
    // See `candidateBuilders`: an unconfirmed turn-OFF, answered by the store.
    unconfirmedRelief: pendingBinaryCommandStore.hasActiveTurnOff(device.id),
    effectivePower,
    fromStepId: selectedStep.id,
    // No ladder: this device is already parked at its shed target, and the whole
    // relief is the binary off that follows. There is no rung for selection to
    // size, and naming its current step as the shed destination would cancel the
    // off that the relief was priced on.
    rungs: [],
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
