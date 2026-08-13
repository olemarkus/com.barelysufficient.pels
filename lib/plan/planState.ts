import type { BinaryControlCapabilityId } from '../../packages/contracts/src/types';
import { RESTORE_COOLDOWN_MS } from './planConstants';
import type { PowerFreshnessState } from './planPowerFreshness';
import type {
  BinaryControlDiscriminantProbe,
  DevicePlanDevice,
  PendingTargetCommandStatus,
  PendingTargetObservationSource,
} from './planTypes';

export type ActivationAttemptSource = 'pels_restore' | 'tracked_step_up';
export type PendingBinaryLogContext = 'capacity' | 'capacity_control_off';
export type PendingBinaryRestoreSource = 'shed_state' | 'current_plan';

export type PendingTargetCommandState = {
  capabilityId: string;
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

export type ActivationAttemptState = {
  penaltyLevel?: number;
  lastSetbackMs?: number;
  startedMs?: number;
  source?: ActivationAttemptSource;
  /**
   * Set to the timestamp of the first clean whole-home sample seen after the
   * attempt started. Used as evidence at window expiry that the household
   * total was actually known and within limits during the attribution window,
   * not just that no overshoot was attributed (which would also be true if
   * the main meter was stale for the entire window).
   */
  cleanWholeHomeSampleAtMs?: number;
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

export type HeadroomCardState = {
  lastUsageKw?: number;
  lastUsageFreshnessMs?: number;
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

  lastDeviceControlledMs: Record<string, number> = {};

  /**
   * Actuation-time clock: the timestamp the executor last actually turned a
   * device off for capacity. Written by the executor — `recordShedActuation`
   * on a real turn-off, plus the degenerate no-onoff shed path in
   * `binaryExecutor`. Drives the actuation-recency readers —
   * the 5s shed throttle, the cooldown countdown card, the reconcile window,
   * and the recent-shed restore backoff. Do NOT use it to answer "is this
   * device in shed posture?": a device the plan decided to shed but that was
   * already off (write skipped) has no entry here. That decision-time
   * question is `shedDecidedMs`.
   */
  lastDeviceShedMs: Record<string, number> = {};

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
   * wiring for main and by each sub-home bundle; absent ⇒ never held ⇒ today's
   * behaviour.
   */
  isExternalOffHeld?: (deviceId: string) => boolean;

  /**
   * Arming clock for startup power reservations (`lib/plan/admission/headroomReserve.ts`): when a
   * device carrying `reservesStartupPower` first began holding a block back from lower-priority
   * admission. Rebuilt wholesale each resolve — a device that leaves the snapshot, stops
   * requesting, or reaches its lowest active step drops its stamp, while an expired reserve keeps
   * its stamp so it stays expired instead of re-arming every cycle. In-memory only: a restart
   * simply gives a still-waiting device a fresh window.
   */
  headroomReserveArmedMs: Record<string, number> = {};

  lastDeviceRestoreMs: Record<string, number> = {};

  /**
   * Executor-owned binary activation attempts for dual-control stepped loads.
   *
   * Separate from `lastDeviceRestoreMs`, which step adjustments also stamp.
   * This cursor prevents an activation-time OFF/reset echo from immediately
   * reissuing a toggle-style binary ON before the post-activation step lands.
   */
  lastSteppedBinaryRestoreAttemptMs: Record<string, number> = {};

  activationAttemptByDevice: Record<string, ActivationAttemptState> = {};

  surplusEligibilityByDevice: Record<string, SurplusEligibilityState> = {};

  headroomCardByDevice: Record<string, HeadroomCardState> = {};

  pendingSheds: Set<string> = new Set<string>();

  pendingRestores: Set<string> = new Set<string>();

  pendingBinaryCommands: Record<string, {
    capabilityId: BinaryControlCapabilityId;
    desired: boolean;
    startedMs: number;
    pendingMs?: number;
    flowBackedControl?: boolean;
    logContext?: PendingBinaryLogContext;
    restoreSource?: PendingBinaryRestoreSource;
    reason?: string;
    // True when issued by the smart-task lifecycle-end disable path (not a
    // capacity shed); routes the deferred flow-backed confirmation through the
    // diagnostic-only release recorder so it does not stamp the cooldown markers.
    lifecycleRelease?: boolean;
    lastObservedValue?: boolean | string;
    lastObservedSource?: PendingTargetObservationSource;
    lastObservedAtMs?: number;
  }> = {};

  pendingTargetCommands: Record<string, PendingTargetCommandState> = {};

  lastInstabilityMs: number | null = null;

  lastRecoveryMs: number | null = null;

  lastRestoreMs: number | null = null;

  lastPlannedShedIds: Set<string> = new Set<string>();

  lastShedPlanMeasurementTs: number | null = null;

  /**
   * Whole-home watts the last shed plan was decided on, latched beside
   * `lastShedPlanMeasurementTs`. A repeat of this exact value on a LATER sample
   * is a re-delivery of the reading we already acted on, not evidence the shed
   * achieved nothing, so `resolveSameMeasurementSheddingDecision` refuses to
   * deepen on it for a short hold. In-memory like its sibling: after a restart
   * the latch is absent and the hold is simply inert.
   */
  lastShedPlanPowerW: number | null = null;

  /**
   * The shedding pass's OWN selection from that same plan — the decision the
   * latched reading produced, re-asserted while the hold is active. Deliberately
   * NOT `lastPlannedShedIds`: that is the FINAL plan's shed set, which
   * `planBuilderSurplus` has already merged the solar dump-load hold and the
   * decoration seam's deferred force-sheds into. Re-asserting from it would hand a solar-held dump
   * load a capacity shed reason, which mislabels it for the user and makes
   * `isAnyOtherDeviceLimited` clamp unrelated stepped loads. Copied at stamp
   * time because the pass's `shedSet` is mutated downstream by those same merges.
   */
  lastShedPlanShedIds: Set<string> = new Set<string>();

  /**
   * When that shed was decided — the hold window's own anchor. Deliberately NOT
   * `lastOvershootMitigationMs`: `PlanBuilder` runs the shedding pass BEFORE
   * `OvershootTracker.updateOvershootState`, whose overshoot-ENTRY branch nulls
   * that field, so the very first shed of an incident would lose its anchor in
   * the same build and the hold would never engage on the cycle that needs it
   * most. Cleared only when the overshoot ends (`clearShedPlanLatch`).
   */
  lastShedPlanAtMs: number | null = null;

  /**
   * The deficit that shed was sized against. A repeated reading only means "no
   * new evidence" while the question is unchanged; if the soft limit tightens
   * (hour rollover, daily-budget recompute) the SAME watts now demand a deeper
   * shed, and that is real new information the reading itself cannot carry. The
   * hold releases when the deficit grows past this.
   */
  lastShedPlanNeededKw: number | null = null;

  /**
   * Drop the shed-plan latch when the overshoot it belongs to is over. The
   * latched reading described a decision taken under pressure that no longer
   * exists; carrying it into the next incident could hold that incident's first
   * shed if the meter happens to report the same watts again.
   */
  clearShedPlanLatch(): void {
    this.lastShedPlanPowerW = null;
    this.lastShedPlanShedIds = new Set<string>();
    this.lastShedPlanAtMs = null;
    this.lastShedPlanNeededKw = null;
  }

  swapByDevice: Record<string, SwapEntry> = {};

  inShortfall: boolean = false;

  restoreCooldownMs: number = RESTORE_COOLDOWN_MS;

  lastRestoreCooldownBumpMs: number | null = null;

  startupRestoreBlockedUntilMs: number | null = null;

  currentRebuildReason: string | null = null;

  lastPowerFreshnessState: PowerFreshnessState | null = null;

  hourlyBudgetExhausted: boolean = false;

  wasOvershoot: boolean = false;

  overshootLogged: boolean = false;

  softOvershootPendingSinceMs: number | null = null;

  /**
   * Remaining hourly capacity budget (kWh) as of the last soft-limit
   * computation. Always resolved — the hour's budget is a fact about the hour,
   * independent of which pace is in force — so consumers read a plain number.
   * Read by the shed grace to price what waiting would cost; 0 means the hour is
   * spent, which buys no grace at all.
   */
  hourlyRemainingKWh: number = 0;

  overshootStartedMs: number | null = null;

  lastOvershootEscalationMs: number | null = null;

  lastOvershootMitigationMs: number | null = null;

  lastPlanTotalKw: number | null = null;

  lastPlanBuiltAtMs: number | null = null;

  lastPlanDevicesById: Record<string, OvershootTrackedPlanDevice> = {};

  temperatureBoostActiveByDevice: Record<string, boolean> = {};

  evBoostActiveByDevice: Record<string, boolean> = {};

  // Per-device: true when a surplus-absorb lift is the binding cause of this cycle's
  // planned target (it raised the setpoint above the price/base target and no deadline
  // floor overrode it). Drives the device card's "Raised to use your solar power" reason.
  surplusAbsorbActiveByDevice: Record<string, boolean> = {};

  lastOvershootSummarySignature: string | null = null;

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

  /**
   * Per-device transient state for the mode-target capability read in
   * `resolveTemperatureSeed`. Used by the abandon-grace window so a single
   * transient SDK miss on `getPrimaryTargetCapability(dev.targets)?.value`
   * does not drop the device from the plan, and by the per-device emit
   * throttle on `missing_mode_target` / `missing_mode_target_and_current_target`
   * so a stuck misconfigured device does not flood the log buffer when the
   * `plan` debug topic is enabled. In-memory only per
   * `feedback_homey_sdk_unreliable` — on restart the first cycle re-emits as
   * expected.
   */
  modeTargetMissingByDevice: Record<string, {
    missingCycles: number;
    cachedTargetValue?: number;
    /**
     * Capability ID the `cachedTargetValue` was read from. Compared against
     * the current primary target capability when the grace path considers
     * reusing the cache so a device re-pair (or driver swap) during the
     * grace window can't reuse a value against a different capability.
     */
    cachedTargetCapabilityId?: string;
    lastEmitAtMs?: number;
    lastEmitEvent?: 'missing_mode_target' | 'missing_mode_target_and_current_target';
  }> = {};

  constructor(nowTs = Date.now(), isExternalOffHeld?: (deviceId: string) => boolean) {
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

  /** Stamp the actuation-time shed clock for a device (executor turn-off). */
  markDeviceShed(deviceId: string, nowMs: number): void {
    this.lastDeviceShedMs[deviceId] = nowMs;
  }

  /** Clear the actuation-time shed clock for a device. */
  clearDeviceShed(deviceId: string): void {
    delete this.lastDeviceShedMs[deviceId];
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

  /** Record a dual-control stepped load's binary activation attempt. */
  markSteppedBinaryRestoreAttempt(deviceId: string, nowMs: number): void {
    this.lastSteppedBinaryRestoreAttemptMs[deviceId] = nowMs;
  }

  /** Whether a dual-control stepped load was recently sent binary ON. */
  hasRecentSteppedBinaryRestoreAttempt(deviceId: string, nowMs: number): boolean {
    const attemptedAtMs = this.lastSteppedBinaryRestoreAttemptMs[deviceId];
    return typeof attemptedAtMs === 'number'
      && nowMs - attemptedAtMs < this.restoreCooldownMs;
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
  nowTs = Date.now(),
  isExternalOffHeld?: (deviceId: string) => boolean,
): PlanEngineState {
  return new PlanEngineState(nowTs, isExternalOffHeld);
}
