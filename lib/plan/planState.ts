import type { PendingBinaryCommand } from '../observer/pendingBinaryCommandTypes';
import { RESTORE_COOLDOWN_MS } from './planConstants';
import type { PlanRebuildTrigger } from './planRebuildTrigger';
import { OvershootIncident } from './overshootIncident';
import { ActuationRecord } from './actuationRecord';
import type {
  BinaryControlDiscriminantProbe,
  DevicePlanDevice,
  PendingTargetCommandStatus,
  PendingTargetObservationSource,
} from './planTypes';

export type ActivationAttemptSource = 'pels_restore' | 'tracked_step_up';

export type PendingTargetCommandState = {
  target: 'temperature';
  desired: number;
  startedMs: number;
  lastAttemptMs: number;
  retryCount: number;
  nextRetryAtMs: number;
  status: PendingTargetCommandStatus;
  lastObservedValue?: unknown;
  lastObservedSource?: PendingTargetObservationSource;
  lastObservedAtMs?: number;
  lastWaitingLogAtMs?: number;
};

/**
 * An activation PELS issued and is still attributing overshoot to. Owned by
 * `lib/plan/admission/activationBackoff.ts`; an entry exists exactly while the
 * attempt is open, so "no entry" is the only spelling of "no attempt".
 */
export type ActivationAttempt = {
  startedMs: number;
  source: ActivationAttemptSource;
  /**
   * Whether a clean whole-home sample arrived after the attempt started. The
   * evidence at window expiry that the household total was actually known and
   * within limits during the attribution window, not just that no overshoot
   * was attributed (which would also be true if no cycle in the window measured
   * the household within its limits).
   */
  cleanWholeHomeSampleSeen: boolean;
};

/**
 * The backoff ladder a device climbed through attributed overshoots. Owned by
 * `lib/plan/admission/activationBackoff.ts`; an entry exists exactly while the
 * level is above zero, and every setback that raised it stamped `lastSetbackMs`.
 */
export type ActivationPenalty = {
  level: number;
  lastSetbackMs: number;
};

/**
 * Per-device surplus-absorb eligibility state, owned by
 * `lib/plan/admission/surplusAbsorb.ts`. `eligible` is the latched decision;
 * `sinceMs` stamps when it last flipped (the min-dwell floor),
 * `pendingSinceMs` stamps when the opposite-flip condition first held (the
 * settle window), and `hardOffSinceMs` stamps when the unambiguous-release
 * (hard-off) condition first held while engaged — sustained for a full settle
 * window it lets a release skip the min dwell. `hardOffReleased` marks a
 * settled-off entry produced by a hard-off release; it keeps the entry alive
 * until the dwell floor expires so the next engage owes the full off-state
 * dwell (limit-cycle bound). Absent entry == not eligible, no pending flip.
 * In-memory only.
 */
export type SurplusEligibilityState = {
  eligible?: boolean;
  sinceMs?: number;
  pendingSinceMs?: number;
  hardOffSinceMs?: number;
  hardOffReleased?: boolean;
};

/**
 * The surplus allocator's answer for a tracking device this build: the rung its
 * surplus bought, or STOPPED.
 *
 * Absence is a THIRD state and must never be read as stopped. It means the
 * allocator had no answer to give — the device is not a stepped load, is not
 * commandable (an unplugged charger), or has no runnable rung — and reading that
 * as "stop" would shed a device for want of sun it was never going to draw.
 *
 * `stopped` says only THAT the device stops, never how. What stopping means is
 * the configured shed action's answer (`ShedBehavior`), reached through the
 * ordinary shed path like any other shed.
 */
export type SurplusTrackingDecision =
  | {
    kind: 'rung';
    stepId: string;
    /**
     * Did the surplus actually pay for this rung? False while the release
     * settle/dwell runs: the gate still says the device may run, but the pool
     * no longer covers even the ladder floor, so the device holds its cheapest
     * rung and the grid covers the difference — the same window every surplus
     * modality has, bounded by the release timing rules rather than by this
     * flag. The card must not claim "running on solar" through it.
     */
    funded: boolean;
  }
  | { kind: 'stopped' };

/**
 * The rung a tracking device is clamped to, or undefined when it holds no rung
 * (stopped, or no answer). The one place the decision is narrowed to a step id,
 * so the three ceiling lanes cannot each invent their own reading of it.
 */
export const resolveSurplusCeilingStepId = (
  state: Pick<PlanEngineState, 'surplusTrackingByDevice'>,
  deviceId: string,
): string | undefined => {
  const decision = state.surplusTrackingByDevice[deviceId];
  return decision?.kind === 'rung' ? decision.stepId : undefined;
};

/**
 * The reading the last shed was decided on and the decision it produced,
 * latched as one pair by the shedding pass (`lib/plan/shedding/overshoot.ts`
 * reads it): a later sample repeating `powerW` exactly is a re-delivery of the
 * reading already acted on, so shedding re-asserts `shedIds` and adds nothing
 * for a short hold from `atMs`, unless the deficit has grown past `neededKw`.
 * Null when no shed has latched since the last incident ended.
 */
export type ShedPlanLatch = {
  readonly powerW: number;
  /** The pass's OWN selection — copied, because the plan's shed set is merged with holds downstream. */
  readonly shedIds: ReadonlySet<string>;
  readonly atMs: number;
  readonly neededKw: number;
};

/**
 * What a shedding pass reports back for the planner state to commit
 * (`applySheddingOutcome`). One of three things happened this cycle: nothing
 * (withheld, held, or nothing to shed), an escalation that found no candidate,
 * or a shed — which stamps the instability clock, the sample it acted on, the
 * latch when the reading carried watts, and whether it was a same-sample
 * escalation.
 */
export type SheddingOutcome =
  | { kind: 'none' }
  | { kind: 'escalation_blocked'; atMs: number }
  | {
    kind: 'shed';
    atMs: number;
    measurementTs: number | null;
    latch: ShedPlanLatch | null;
    escalatedSameSample: boolean;
  };

/** The one `none` outcome, shared: it carries nothing, so every quiet cycle answers the same object. */
export const NO_SHEDDING_OUTCOME: SheddingOutcome = Object.freeze({ kind: 'none' });

export type HeadroomCardState = {
  lastUsageKw?: number;
  deviceName?: string;
  lastStepDownMs?: number;
};

export type SwapEntry = {
  swappedOutFor?: string;
  pendingTarget?: boolean;
  timestamp?: number;
  lastPlanMeasurementTs?: number;
  requestedTargetStepId?: string;
  requestedDesiredStepId?: string;
};

export type OvershootTrackedPlanDevice = Pick<
  DevicePlanDevice,
  | 'id'
  | 'name'
  | 'controllable'
  | 'plannedState'
  | 'currentState'
  | 'currentDrawKw'
  | 'expectedPowerKw'
  | 'binaryCommandPending'
  | 'stepCommandPending'
  | 'reason'
>
  // `binaryControl` is OMITTED from `DevicePlanDeviceBase` (orthogonal
  // `BinaryControlKind`), so it can't be Pick'd off the base — carry it as the
  // optional probe shape, sourced by the producer via `isBinaryPlanDevice`.
  & BinaryControlDiscriminantProbe
  & {
    // Same reason as `binaryControl` above: `planningPowerKw` lives on the
    // orthogonal `SteppedLoadKind`, so it can't be Pick'd off the base. Carried
    // flat here as the optional it is on a stepped device, sourced by the
    // producer via `isSteppedLoadDevice`.
    planningPowerKw?: number;
    pendingBinaryOnCommand: boolean;
    pendingBinaryOffCommand: boolean;
    pendingTargetCommand: boolean;
  };

/**
 * Shared plan-engine state. Modelled as a `class` (not a plain object) so the
 * executor's cross-cutting mutations go through narrow mutator METHODS: in
 * `lib/executor` (where `functional/immutable-data` / `no-param-reassign` are
 * ON) the old in-place `state.x = …` writes needed a per-site disable, whereas
 * `this.*` writes inside these methods are exempt via the rules' `ignoreClasses`.
 * All data fields stay PUBLIC; they're read transparently by reference across
 * `lib/plan`, and the planner mutates them directly there (allowed because
 * `lib/plan` is a hot-path dir with `functional/immutable-data` off). Construct
 * only via `createPlanEngineState`. No code spreads/clones this object, so the
 * loss of methods under a hypothetical spread is moot.
 */
export class PlanEngineState {
  appStartedAtMs: number;

  /** What the executor did to which device and when — see `ActuationRecord`. */
  readonly actuation = new ActuationRecord();

  /**
   * Decision-time clock: the timestamp the planner decided a device should be
   * held in capacity-shed posture. Owned by the planner — edge-set at plan
   * finalization for every device entering `lastPlannedShedIds` (so a
   * decided-but-already-off device is recorded even when the executor skips
   * the write), and cleared on restore exactly where `lastDeviceShedMs` is
   * (controlled restores age it out via the `lastDeviceRestoreMs` comparison;
   * uncontrolled `capacity_control_off` restores delete it). This is the
   * intent/existence fact the restore-eligibility readers consult —
   * recovering, stepped-restore blocking, restore-log source, and the
   * uncontrolled-restore stability gate — so a write-skipped shed no longer
   * under-stamps and lets a device restore early. See
   * `notes/state-management/deferred-objective-lifecycle-carveout.md`.
   */
  shedDecidedMs: Record<string, number> = {};

  /**
   * Plan-less-safe "Run on solar surplus" posture stamp: `true` for a device
   * whose CURRENT shed decision was taken while it carried the producer-resolved
   * `surplusOnly` dump-load posture. Maintained by the planner alongside
   * `shedDecidedMs` (refreshed for every planned-shed device each build, so a
   * posture toggle while held updates it) and cleared with the decision clock
   * (`clearShedDecision`). The executor's capacity-control-off/uncontrolled
   * binary restore lanes consult THIS stamp — never the plan device — so
   * turning capacity control off (or unmanaging) can never force-turn-ON a
   * baseline-off dump load, even from a cold/absent plan. In-memory only: a
   * restart drops both this stamp and `shedDecidedMs` together, and the
   * uncontrolled-restore lane requires `shedDecidedMs`, so the restart race is
   * fail-safe (no stamp ⇒ no decision ⇒ no forced ON).
   */
  surplusOnlyShedByDevice: Record<string, true> = {};

  /**
   * "Leave off until turned on again" — the plan-less-safe read for the
   * executor's restore carve-out. A FLAT getter, not the policy port: plan and
   * executor code must not be handed a surface that can mutate persisted
   * settings, and the getter is the same resolution the producer applies (hold
   * AND still observed off), so there is exactly one definition of "held" and
   * the two layers cannot disagree.
   *
   * Read here rather than off the plan device on purpose, exactly like
   * `surplusOnlyShedByDevice`: a cold, stale, or absent plan must not resume a
   * device the user turned off. Unlike that stamp this one is backed by
   * persistence, so the guard also holds across a restart. Assigned by the
   * wiring for main and by each sub-home bundle.
   */
  readonly isExternalOffHeld: (deviceId: string) => boolean;


  /**
   * Arming clock for startup power reservations (`lib/plan/admission/headroomReserve.ts`): when a
   * device carrying `reservesStartupPower` first began holding a block back from lower-priority
   * admission. Rebuilt wholesale each resolve — a device that leaves the snapshot, stops
   * requesting, or reaches its lowest active step drops its stamp, while an expired reserve keeps
   * its stamp so it stays expired instead of re-arming every cycle. In-memory only: a restart
   * simply gives a still-waiting device a fresh window.
   */
  headroomReserveArmedMs: Record<string, number> = {};

  activationAttemptByDevice: Record<string, ActivationAttempt> = {};

  activationPenaltyByDevice: Record<string, ActivationPenalty> = {};

  surplusEligibilityByDevice: Record<string, SurplusEligibilityState> = {};

  headroomCardByDevice: Record<string, HeadroomCardState> = {};

  pendingBinaryCommands: Record<string, PendingBinaryCommand> = {};

  pendingTargetCommands: Record<string, PendingTargetCommandState> = {};

  lastInstabilityMs: number | null = null;

  lastRecoveryMs: number | null = null;

  lastPlannedShedIds: Set<string> = new Set<string>();

  lastShedPlanMeasurementTs: number | null = null;

  /**
   * The unchanged-reading latch — see `ShedPlanLatch`. Its `shedIds` is the
   * shedding pass's OWN selection, deliberately NOT `lastPlannedShedIds`: that
   * is the FINAL plan's shed set, which `planBuilderSurplus` has already merged
   * the solar dump-load hold and the decoration seam's deferred force-sheds
   * into. Re-asserting from it would hand a solar-held dump load a capacity
   * shed reason, which mislabels it for the user and makes
   * `isAnyOtherDeviceLimited` clamp unrelated stepped loads. Its `atMs` is the
   * hold window's own anchor, deliberately NOT the incident's mitigation clock
   * (`OvershootIncident`): `PlanBuilder` runs the shedding pass BEFORE
   * `OvershootTracker.updateOvershootState`, whose entry resets that clock, so
   * the very first shed of an incident would lose its anchor in the same build
   * and the hold would never engage on the cycle that needs it most. In-memory
   * like `lastShedPlanMeasurementTs`: after a restart the latch is absent and
   * the hold is simply inert. Cleared only when the overshoot ends.
   */
  shedPlanLatch: ShedPlanLatch | null = null;

  /**
   * Drop the shed-plan latch when the overshoot it belongs to is over. The
   * latched reading described a decision taken under pressure that no longer
   * exists; carrying it into the next incident could hold that incident's first
   * shed if the meter happens to report the same watts again.
   */
  clearShedPlanLatch(): void {
    this.shedPlanLatch = null;
  }

  /**
   * Commit what a shedding pass reports back, and the recovery it saw. The pass
   * returns these rather than writing them so it stays a pure function of one
   * cycle; this is the one place they land.
   */
  applySheddingOutcome(outcome: SheddingOutcome, recoveredAtMs: number | null): void {
    if (recoveredAtMs !== null) this.lastRecoveryMs = recoveredAtMs;
    if (outcome.kind === 'none') return;
    this.overshoot.noteMitigation(outcome.atMs);
    if (outcome.kind === 'escalation_blocked') {
      this.overshoot.noteEscalation(outcome.atMs);
      return;
    }
    this.lastInstabilityMs = outcome.atMs;
    if (outcome.measurementTs !== null) this.lastShedPlanMeasurementTs = outcome.measurementTs;
    if (outcome.latch !== null) this.shedPlanLatch = outcome.latch;
    if (outcome.escalatedSameSample) this.overshoot.noteEscalation(outcome.atMs);
  }

  swapByDevice: Record<string, SwapEntry> = {};

  inShortfall: boolean = false;

  /**
   * The shedding latch: true from the build that decides to shed until a build
   * sees headroom clear `SHEDDING_CLEAR_THRESHOLD_KW`. Latched rather than
   * recomputed per build so a plan hovering at the threshold cannot flap it.
   *
   * Planner state because only the planner decides it: `updateGuardState`
   * writes it, `buildSheddingPlan` reads the previous value to detect recovery,
   * and every downstream consumer takes it off `SheddingPlan`. It used to live
   * on `CapacityGuard`, which re-checked the release predicate the planner had
   * already evaluated and could refuse silently — leaving the caller to re-read
   * the guard to discover what its own request had done.
   */
  sheddingActive: boolean = false;

  restoreCooldownMs: number = RESTORE_COOLDOWN_MS;

  lastRestoreCooldownBumpMs: number | null = null;

  startupRestoreBlockedUntilMs: number | null = null;

  currentRebuildTrigger: PlanRebuildTrigger | null = null;

  /**
   * Whether this hour's capacity budget is spent, as of the pace stamp taken at
   * the top of the current build. `PlanBuilder.stampCapacityPace` is the only
   * writer, and only the build calls it: a status log, a Flow condition or the
   * rebuild scheduler asking for the pace is a read
   * (`PlanBuilder.computeDynamicSoftLimit`) and must leave this alone. One
   * writer per build is what keeps the shed decision and the reason/meta pass
   * that labels it answering to the same hour.
   */
  hourlyBudgetExhausted: boolean = false;

  /**
   * Remaining hourly capacity budget (kWh) as of the last soft-limit
   * computation. Always resolved — the hour's budget is a fact about the hour,
   * independent of which pace is in force — so consumers read a plain number.
   * Read by the shed grace to price what waiting would cost; 0 means the hour is
   * spent, which buys no grace at all. Written by `stampCapacityPace` only —
   * same single-writer rule as `hourlyBudgetExhausted`.
   */
  hourlyRemainingKWh: number = 0;

  /** The overshoot incident in progress, if any — see `OvershootIncident`. */
  readonly overshoot = new OvershootIncident();

  // Per-device: last cycle's boost decision, kept only so the transition can be
  // logged once when it flips. One map for one boost truth — the per-kind pair
  // it replaced tracked two flags the planner could not tell apart anyway.
  boostActiveByDevice: Record<string, boolean> = {};

  // Per-device: true when a surplus-absorb lift is the binding cause of this cycle's
  // planned target (it raised the setpoint above the price/base target and no deadline
  // floor overrode it). Drives the device card's "Raised to use your solar power" reason.
  surplusAbsorbActiveByDevice: Record<string, boolean> = {};

  // Per-device: this cycle's surplus allocation for a surplus-TRACKING device.
  // A rung is read as a CEILING on the desired step — never as an instruction to
  // actuate — so capacity shedding stays the ceiling above it. In-memory like its
  // siblings: a restart drops it, and the next build re-allocates from a fresh
  // meter reading.
  surplusTrackingByDevice: Record<string, SurplusTrackingDecision> = {};

  // Per-device: when the tracking ceiling above last MOVED UP. Paces climbs only
  // — see `SURPLUS_TRACK_STEP_MIN_INTERVAL_MS`. In-memory, pruned in lockstep
  // with the decision itself.
  surplusTrackingRaisedMs: Record<string, number> = {};

  steppedRestoreRejectedByDevice: Record<string, {
    requestedStepId: string;
    lowestNonZeroStepId: string;
    shedDeviceCount: number;
  }> = {};

  keepInvariantShedBlockedByDevice: Record<string, {
    desiredStepId: string;
    lowestNonZeroStepId: string;
  }> = {};

  restoreDecisionLogByKey: Record<string, string> = {};

  constructor(
    nowTs: number,
    isExternalOffHeld: (deviceId: string) => boolean,
  ) {
    this.appStartedAtMs = nowTs;
    this.isExternalOffHeld = isExternalOffHeld;
  }

  /**
   * Record one plan build's planned-shed decisions (called at plan
   * finalization). Edge-sets the decision-time shed clock (`shedDecidedMs`) on
   * the transition into the shed set — a decided-but-already-off device is
   * recorded even when the executor skips the write; not refreshed while held,
   * so a re-shed after a restore re-stamps a fresh decision time. Also
   * maintains the plan-less-safe surplus-posture stamp
   * (`surplusOnlyShedByDevice`): REFRESHED (not edge-set) for every currently
   * planned-shed device, so toggling the posture off while held clears it.
   */
  recordPlannedShedDecisions(params: {
    shedIds: Set<string>;
    surplusOnlyIds: ReadonlySet<string>;
    nowTs: number;
  }): void {
    for (const id of params.shedIds) {
      if (!this.lastPlannedShedIds.has(id)) {
        this.shedDecidedMs[id] = params.nowTs;
      }
      if (params.surplusOnlyIds.has(id)) {
        this.surplusOnlyShedByDevice[id] = true;
      } else {
        delete this.surplusOnlyShedByDevice[id];
      }
    }
    this.lastPlannedShedIds = params.shedIds;
  }

  /**
   * Clear the decision-time shed clock for a device, together with its
   * surplus-posture stamp (the stamp qualifies the decision, so they live and
   * die together).
   */
  clearShedDecision(deviceId: string): void {
    delete this.shedDecidedMs[deviceId];
    delete this.surplusOnlyShedByDevice[deviceId];
  }

  /** Record a stepped-load keep-invariant shed block for a device. */
  setKeepInvariantShedBlock(
    deviceId: string,
    entry: PlanEngineState['keepInvariantShedBlockedByDevice'][string],
  ): void {
    this.keepInvariantShedBlockedByDevice[deviceId] = entry;
  }

  /** Clear a stepped-load keep-invariant shed block for a device. */
  clearKeepInvariantShedBlock(deviceId: string): void {
    delete this.keepInvariantShedBlockedByDevice[deviceId];
  }

  /** Drop the pending target-command record for a device (confirmed/settled). */
  deletePendingTargetCommand(deviceId: string): void {
    delete this.pendingTargetCommands[deviceId];
  }

  /**
   * Clear the pending-target markers on a device's swap entry, dropping the
   * entry entirely once it carries no residual swap state.
   */
  clearPendingSwapTarget(deviceId: string): void {
    const swapEntry = this.swapByDevice[deviceId];
    if (!swapEntry) return;
    delete swapEntry.pendingTarget;
    delete swapEntry.timestamp;
    if (!swapEntry.swappedOutFor && swapEntry.lastPlanMeasurementTs === undefined) {
      delete this.swapByDevice[deviceId];
    }
  }
}

export function createPlanEngineState(
  nowTs: number,
  isExternalOffHeld: (deviceId: string) => boolean,
): PlanEngineState {
  return new PlanEngineState(nowTs, isExternalOffHeld);
}
