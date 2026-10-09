import type { PendingBinaryCommand } from '../observer/pendingBinaryCommandTypes';
import type { PlanRebuildTrigger } from './planRebuildTrigger';
import type { PlanLimits } from './planContext';
import { OvershootIncident } from './overshootIncident';
import { ActuationRecord } from './actuationRecord';
import { RestoreBackoff } from './restoreBackoff';
import { ShedDecisions } from './shedDecisions';
import { SwapLedger } from './swap';
import type {
  BinaryControlDiscriminantProbe,
  DevicePlanDevice,
  MeteredKind,
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
 * The reading the last shed was decided on and the decisions it stands on,
 * latched as one pair by the shedding pass (`lib/plan/shedding/pendingRelief.ts`
 * reads it). For a short window from each decision, the relief it counted on
 * still counts against a later reading that does not show it yet, so shedding
 * holds those devices where `stepTargets` put them and adds only what that
 * relief leaves open. Null when no shed has latched since the last incident
 * ended.
 */
export type ShedPlanLatch = {
  readonly powerW: number;
  /**
   * Per device the shedding pass limited — its OWN selection, never the plan's
   * shed set, which is merged with holds downstream — its decisions oldest
   * first: when each was decided and the relief it banked that `powerW` does not
   * show. A device chosen again after delivering gets a decision beside its
   * earlier one, so each keeps its own window.
   */
  readonly decisions: ReadonlyMap<string, readonly ShedLatchDecision[]>;
  /** The rung each stepped device was sent to, which a hold keeps it at rather than re-pricing it. */
  readonly stepTargets: ReadonlyMap<string, string>;
};

export type ShedLatchDecision = {
  /** When this device's shed was decided: its credit's own window runs from here. */
  readonly decidedAtMs: number;
  /**
   * Relief this decision banked that the latched reading does not show. Zero for
   * a device selected while an older command's relief was still unconfirmed:
   * an older decision's relief earns no credit.
   */
  readonly creditedKw: number;
};

/**
 * What a shedding pass reports back for the planner state to commit
 * (`applySheddingOutcome`). One of four things happened this cycle: nothing
 * (withheld, or nothing to shed), decisions in their window held with nothing
 * added, an escalation that found no candidate, or a shed — which stamps the
 * instability clock, the sample it acted on, the latch when the reading carried
 * watts, and whether it was a same-sample escalation.
 */
export type SheddingOutcome =
  | { kind: 'none' }
  /**
   * Nothing new was decided, but decisions in their window were held, and the
   * latch they stand on is committed as the pass left it: a decision whose
   * relief the reading has shown, or whose device has gone, is retired, so a
   * later rise in the reading cannot bring its credit back. No clock is stamped
   * — nothing was mitigated, so each decision's window keeps running.
   */
  | { kind: 'held'; latch: ShedPlanLatch }
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

/**
 * The plan's hold on one home battery (`lib/plan/battery/`). An entry exists
 * exactly while the plan is driving the battery; releasing it deletes the
 * entry. In memory: after a restart the owner's boot recovery hands a claimed
 * battery back, and the next limit or surplus claims it afresh.
 */
export type StorageLeverState = {
  /**
   * The signed power this plan holds the battery at, W: negative discharges,
   * positive charges. Under a `limit` hold it is the battery's place on its
   * limiting ladder (max charge, then 0 W, then max discharge); under a
   * `surplus` hold the charge the consumers ranked above it leave it
   * (`StorageSurplusOffer`).
   */
  setpointW: number;
  /**
   * Why the plan holds the battery: `limit`, chosen by shedding at its own place
   * in the priority order (its charge capped, or discharged to hold the limit),
   * and handed back only by the restore lane in priority order; or `surplus`,
   * to cap its own mode's charge for a device (handed back after
   * `STORAGE_SURPLUS_RELEASE_DWELL_MS` without a device needing the cap). A
   * surplus hold that shedding chooses becomes a limit hold.
   */
  purpose: 'limit' | 'surplus';
  /**
   * When the current discharge increase was decided: its credit's settle
   * window runs from here. A hold that only caps the charge has no discharge
   * to settle: its window is already over.
   */
  increaseDecidedAtMs: number;
  /**
   * The discharge already accounted for when that increase was decided, W (0
   * or more: a stopped charge is pending relief, never this credit). Only what
   * the battery still has to deliver above it is credited to shedding, so an
   * increase that never landed is not credited again by the next one.
   */
  creditBaseW: number;
  /**
   * When the discharge last stepped down: discharge decreases are paced, its
   * increases are not. A charge is the other way round: it falls at once.
   */
  lastDecreaseAtMs: number;
  /** When the charge last rose: charge increases are paced like other surplus claims. */
  chargeRaisedAtMs: number;
  /**
   * For a surplus hold, the last cycle it was needed: a device wanting surplus
   * while the charge is capped below `preClaimSignedW`; its dwell counts from
   * here. For a limit hold, the last cycle shedding chose it: a battery that
   * has not followed it within the credit's window banks nothing more.
   */
  lastNeedAtMs: number;
  /**
   * The battery's own signed power when the plan first claimed it, W. Handed
   * back, it would charge again at about this rate (`ownModeChargeW`), and a
   * surplus hold is a cap on it.
   */
  preClaimSignedW: number;
  /**
   * The charge its own mode takes once handed back, W, as last read: the
   * pre-claim charge within the battery's charge ceiling, or the ceiling when
   * it was not seen charging then (`resolveOwnModeChargeW`). The restore lane
   * sizes a limit hold's hand-back on it (`lib/plan/restore/storageHandBack.ts`).
   */
  ownModeChargeW: number;
  /** The battery's setpoint grid, W, as last read: a hold kept while unread still names it. */
  stepW: number;
  /**
   * Whether the battery read last cycle, or since when it has had no readable
   * storage input while held. An unread hold is kept, uncredited, and released
   * once it has lasted `STORAGE_INPUT_MISSING_RELEASE_MS`.
   */
  reading: { kind: 'read' } | { kind: 'unread'; sinceMs: number };
};

export type HeadroomCardState = {
  lastUsageKw?: number;
  deviceName?: string;
  lastStepDownMs?: number;
};

export type OvershootTrackedPlanDevice = Pick<
  DevicePlanDevice,
  | 'id'
  | 'name'
  | 'control'
  | 'plannedState'
  | 'currentState'
  | 'expectedPowerKw'
  | 'binaryCommandPending'
  | 'stepCommandPending'
  | 'reason'
>
  // Overshoot attribution compares measured draw between plans, so only a device
  // with a power axis is tracked.
  & MeteredKind
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

  /** How long restores wait after instability, and when it last was — see `RestoreBackoff`. */
  readonly restoreBackoff = new RestoreBackoff();

  /** What the plan decided to hold shed, and under which posture — see `ShedDecisions`. */
  readonly shedDecisions = new ShedDecisions();

  /**
   * "Leave off until turned on again" — the plan-less-safe read for the
   * executor's restore carve-out. A FLAT getter, not the policy port: plan and
   * executor code must not be handed a surface that can mutate persisted
   * settings, and the getter is the same resolution the producer applies (hold
   * AND still observed off), so there is exactly one definition of "held" and
   * the two layers cannot disagree.
   *
   * Read here rather than off the plan device on purpose: a cold, stale, or
   * absent plan must not resume a device the user turned off. It is backed by
   * persistence, so the guard also holds across a restart. The stored read is
   * assigned by the wiring for main and by each sub-home bundle.
   *
   * The one exception is a smart task: a device whose task books the latest
   * build's hour is not held (`externalOffHoldLiftedIds`).
   */
  readonly isExternalOffHeld = (deviceId: string): boolean => (
    this.isStoredExternalOffHeld(deviceId) && !this.externalOffHoldLiftedIds.has(deviceId)
  );

  private readonly isStoredExternalOffHeld: (deviceId: string) => boolean;

  /**
   * Held devices the latest build's smart task drives this hour: a task wins
   * over "Leave off until turned on again" (owner ruling, 2026-10-06). Replaced
   * wholesale every build, so the lift ends with the booked hour; the stored
   * hold itself ends only when the device is observed on.
   */
  externalOffHoldLiftedIds: ReadonlySet<string> = new Set();


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

  lastShedPlanMeasurementTs: number | null = null;

  /**
   * The pending-relief latch — see `ShedPlanLatch`. Its `decisions` are the
   * shedding pass's OWN selection, deliberately NOT `shedDecisions.lastPlannedShedIds`: that
   * is the FINAL plan's shed set, which `planBuilderSurplus` has already merged
   * the solar dump-load hold and the decoration seam's deferred force-sheds
   * into. Re-asserting from it would hand a solar-held dump load a capacity
   * shed reason, which mislabels it for the user and makes
   * `isAnyOtherDeviceLimited` clamp unrelated stepped loads. Each decision's
   * `decidedAtMs` is its credit window's own anchor, deliberately NOT the
   * incident's mitigation clock (`OvershootIncident`): `PlanBuilder` runs the
   * shedding pass BEFORE `OvershootTracker.updateOvershootState`, whose entry
   * resets that clock, so the very first shed of an incident would lose its
   * anchor in the same build and nothing would be credited on the cycle that
   * needs it most. In-memory
   * like `lastShedPlanMeasurementTs`: after a restart the latch is absent and
   * no relief is credited. Cleared only when the overshoot ends.
   */
  shedPlanLatch: ShedPlanLatch | null = null;

  /**
   * Drop the shed-plan latch when the overshoot it belongs to is over. The
   * latched reading described a decision taken under pressure that no longer
   * exists; carrying it into the next incident could credit that decision's
   * relief against the new incident's first shed.
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
    if (recoveredAtMs !== null) this.restoreBackoff.noteRecovery(recoveredAtMs);
    if (outcome.kind === 'none') return;
    if (outcome.kind === 'held') {
      this.shedPlanLatch = outcome.latch;
      return;
    }
    this.overshoot.noteMitigation(outcome.atMs);
    if (outcome.kind === 'escalation_blocked') {
      this.overshoot.noteEscalation(outcome.atMs);
      return;
    }
    this.restoreBackoff.noteInstability(outcome.atMs);
    if (outcome.measurementTs !== null) this.lastShedPlanMeasurementTs = outcome.measurementTs;
    if (outcome.latch !== null) this.shedPlanLatch = outcome.latch;
    if (outcome.escalatedSameSample) this.overshoot.noteEscalation(outcome.atMs);
  }

  /**
   * Live swap reservations — see `SwapLedger`. A model, not a per-cycle
   * projection: the reservation's renewable clock only means anything if the
   * object outlives the rebuild, and a DTO round-trip through a single
   * timestamp slot silently discarded it.
   */
  readonly swapLedger = new SwapLedger();

  inShortfall: boolean = false;

  /**
   * The shedding latch: true from the build that decides to shed until a build
   * sees headroom clear `SHEDDING_CLEAR_THRESHOLD_KW`. Latched rather than
   * recomputed per build so a plan hovering at the threshold cannot flap it.
   *
   * Planner state because only the planner decides it: `buildSheddingPlan`
   * writes it (`resolveSheddingLatch`), `buildSheddingPlan` reads the previous value to detect recovery,
   * and every downstream consumer takes it off `SheddingPlan`. It used to live
   * on `CapacityGuard`, which re-checked the release predicate the planner had
   * already evaluated and could refuse silently — leaving the caller to re-read
   * the guard to discover what its own request had done.
   */
  sheddingActive: boolean = false;

  currentRebuildTrigger: PlanRebuildTrigger | null = null;

  /**
   * Whether the selected capacity period's budget is spent, as of the pace stamp taken at
   * the top of the current build. `PlanBuilder.stampCapacityPace` is the only
   * writer, and only the build calls it: a status log, a Flow condition or the
   * rebuild scheduler asking for the pace or the physical limit is a read
   * (`PlanBuilder.computeCapacityPace`, `PlanBuilder.computePhysicalPowerLimit`)
   * and must leave this alone. One
   * writer per build is what keeps the shed decision and the reason/meta pass
   * that labels it answering to the same period. The `hourly*` spelling is a
   * retained local alias documented in `notes/safe-pace-two-constraints.md`.
   *
   * A FACT about the period, stamped on every build whether or not Capacity
   * limit is on: period tracking continues when it is off. What acts on it is
   * gated on the cycle's capacity pace — `capacityPeriodSpentFor` — so a spent
   * period sheds, holds and labels nothing with Capacity limit off.
   */
  hourlyBudgetExhausted: boolean = false;

  /**
   * Remaining selected-period capacity budget (kWh) as of the last soft-limit
   * computation. Always resolved — the period budget is a fact about the period,
   * independent of which pace is in force and of whether Capacity limit is on —
   * so consumers read a plain number. Read by the shed grace to price what
   * waiting would cost; 0 means the period is spent, which buys no grace at all.
   * With Capacity limit off nothing prices the wait against it
   * (`PlanBuilder.decideOvershoot`). Written by `stampCapacityPace` only — same
   * single-writer rule as `hourlyBudgetExhausted`. The `hourly*` spelling is the
   * retained local alias from the terminology note.
   */
  hourlyRemainingKWh: number = 0;

  /**
   * Whether the spent period acts on this cycle: the stamped fact
   * (`hourlyBudgetExhausted`) while the cycle has a capacity pace
   * (`PlanLimits.capacitySoftLimit`, `null` with Capacity limit off). Every stage
   * that acts on an exhausted period — shedding everything, the shedding latch,
   * holding restores, the spent-period reason, the clean-sample stamp and the
   * published flag — asks this, never the bare fact.
   */
  capacityPeriodSpentFor(limits: Pick<PlanLimits, 'capacitySoftLimit'>): boolean {
    return limits.capacitySoftLimit !== null && this.hourlyBudgetExhausted;
  }

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

  // Per-device: the plan's hold on a home battery — see
  // `StorageLeverState`. In-memory like its siblings.
  storageLeverByDevice: Readonly<Record<string, StorageLeverState>> = {};

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
    this.isStoredExternalOffHeld = isExternalOffHeld;
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

}

export function createPlanEngineState(
  nowTs: number,
  isExternalOffHeld: (deviceId: string) => boolean,
): PlanEngineState {
  return new PlanEngineState(nowTs, isExternalOffHeld);
}
