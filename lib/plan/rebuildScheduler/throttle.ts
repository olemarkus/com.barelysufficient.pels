import type CapacityGuard from '../../power/capacityGuard';
import { addPerfDuration, incPerfCounter, incPerfCounters } from '../../utils/perfCounters';
import type { PlanRebuildTrigger, PowerSampleRebuildTrigger } from '../planRebuildTrigger';
import {
  isTightReason,
  POWER_SAMPLE_REBUILD_CADENCE,
  resolveRebuildDecision,
  resolveRebuildIntentKind,
  resolveRebuildReason,
  resolveTightNoopBackoffMs,
  shouldApplyTightMitigationHoldoff,
  shouldApplyTightNoopBackoff,
  TIGHT_MITIGATION_HOLDOFF_MS,
  TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS,
  type RebuildDecision,
  type RebuildOutcome,
} from './policy';
import {
  resolveHardCapBreach,
  type AdmittedPowerReading,
  type HardCapBreach,
  type PlanRebuildPosture,
  type PowerRebuildSignal,
} from './rebuildSignal';
import type { PlanRebuildScheduler, RebuildIntent } from './scheduler';
import type { LastRebuild, PlanRebuildThrottleMemory, RebuildHoldoff } from './throttleMemory';

export {
  type LastRebuild,
  type PlanRebuildThrottleMemory,
  type RebuildHoldoff,
} from './throttleMemory';

const NO_BREACH: HardCapBreach = { breached: false, deficitKw: 0 };

type RebuildDeferred = {
  promise: Promise<void | string>;
  resolve: (value: string | undefined) => void;
};

/** The ONE rebuild waiting for its due time; later samples coalesce into it. */
type QueuedRebuild = {
  dueMs: number;
  trigger: PowerSampleRebuildTrigger;
  signal: PowerRebuildSignal;
  deferred: RebuildDeferred;
};

/**
 * What the throttle may ask of the guard: whether an incident is latched, and
 * to take a reading. Not a plan verdict — the throttle holds no device list, and
 * the one time it passed the guard a verdict of its own it opened incidents
 * with kilowatts still reducible.
 */
export type ThrottleCapacityGuardView = Pick<CapacityGuard, 'isInShortfall' | 'recordReading'>;

export type PlanRebuildThrottleDeps = {
  /** Late-bound: the scheduler's `executeIntent` calls back into this throttle. */
  getScheduler: () => PlanRebuildScheduler;
  getCapacityGuard: () => ThrottleCapacityGuardView;
  getNowMs: () => number;
  /**
   * `PlanService.rebuildPlanFromCache`. It never rejects: the plan queue
   * contains a build that threw and resolves it as `failed: true`, which is the
   * only failure this throttle handles.
   */
  rebuildPlanFromCache: (trigger: PowerSampleRebuildTrigger) => Promise<RebuildOutcome>;
};

const createDeferred = (): RebuildDeferred => {
  let resolve!: (value: string | undefined) => void;
  const promise = new Promise<void | string>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const incReasonCounter = (base: string, reason: string): void => {
  incPerfCounter(`${base}.${reason}_total`);
};

/**
 * The throttle between a whole-home reading and a plan rebuild.
 *
 * A reading is what triggers a rebuild (root `AGENTS.md` § Control Flow), but a
 * rebuild costs ~1.4 s of CPU on the Homey, and rebuilding on every 6–9 s
 * reading trips its `cpuwarn` watchdog. So each reading is answered here with
 * one of three things: rebuild now, rebuild at a due time (later readings
 * coalesce into that one slot), or not now — and "not now" is decided at the
 * first gate that says so. The gates, in order: never before the first rebuild
 * is skipped; nothing actionable in shortfall → max-interval cadence only; a
 * hard-cap breach → now; a live holdoff → skip; a capacity boundary, a
 * meaningful power delta while converging, or the max interval → rebuild.
 *
 * This class OWNS its memory (`PlanRebuildThrottleMemory`). It used to be a
 * 21-field record of optionals held by the wiring layer and threaded through
 * get/set closures into free functions here, the intent policy, the telemetry
 * observer and the device transport — a shared mutable record with no owner,
 * which is what 21 optionals look like in a type. The wiring now holds the
 * throttle and calls it. One instance per home: main's and each sub-home's
 * memory describe different houses.
 */
export class PlanRebuildThrottle {
  private lastRebuild: LastRebuild | null = null;

  private noopStreak = 0;

  private holdoff: RebuildHoldoff | null = null;

  private suppressionInvalidated = false;

  private observationSeq = 0;

  private lastDecisionUnactionable = false;

  private queued: QueuedRebuild | null = null;

  private inFlight: Promise<void | string> | null = null;

  constructor(private readonly deps: PlanRebuildThrottleDeps) {}

  /**
   * One admitted whole-home reading. Resolves the signal once, then walks the
   * gates; the promise settles when the rebuild this reading caused (or joined)
   * completes, with the cancel reason if it was cancelled first.
   */
  onSample(reading: AdmittedPowerReading, posture: PlanRebuildPosture): Promise<void | string> {
    const rebuildStart = Date.now();
    const signal: PowerRebuildSignal = {
      currentPowerW: reading.currentPowerW,
      totalKw: reading.totalKw,
      limitKw: reading.limitKw,
      capacityPaceKw: reading.capacityPaceKw,
      headroomKw: reading.capacityPaceKw - reading.totalKw,
      shortfallThresholdKw: reading.shortfallThresholdKw,
      isInShortfall: this.deps.getCapacityGuard().isInShortfall(),
      hardCapBreach: resolveHardCapBreach(reading.totalKw, reading.shortfallThresholdKw),
      planConvergenceActive: posture.planConvergenceActive,
      unactionable: posture.unactionable,
    };
    // The latch is not spent here. Only a rebuild that read the observed device
    // spends it (`execute`): a reading that rebuilds nothing leaves the
    // pre-observation verdict standing, and spending the latch on one held the
    // next breach to the max interval behind a plan built without that device.
    return this.decide(signal, posture, this.deps.getCapacityGuard()).finally(() => {
      addPerfDuration('power_sample_rebuild_ms', Date.now() - rebuildStart);
    });
  }

  /**
   * Run the queued rebuild now. Called by the scheduler when the intent this
   * throttle requested comes due; a scheduler that fires with nothing queued
   * (the request was cancelled) has nothing to run.
   */
  execute(): Promise<void> {
    const queued = this.queued;
    if (queued === null) return Promise.resolve();
    this.queued = null;
    const { trigger, signal, deferred } = queued;
    // Captured BEFORE the await. Anything that moves this while the rebuild runs
    // is a device the rebuild's plan input never saw.
    const observationSeqAtDispatch = this.observationSeq;
    const dispatchedAtMs = this.deps.getNowMs();
    const previousBreach = this.lastRebuild === null ? NO_BREACH : this.lastRebuild.hardCapBreach;
    this.lastRebuild = { atMs: dispatchedAtMs, powerW: signal.currentPowerW, hardCapBreach: previousBreach };
    this.inFlight = deferred.promise;
    incPerfCounters(['plan_rebuild_execute_total', 'plan_rebuild_execute.power_sample_total']);
    incReasonCounter('plan_rebuild_execute.power_sample_reason', trigger);

    return this.deps.rebuildPlanFromCache(trigger)
      .then((outcome) => {
        // Nothing here tells the guard about the breach. A build that ran told
        // it with the plan's own verdict (`reportShortfallToGuard`); a gated one had
        // no plan to give a verdict from. An outcome that changed nothing is not
        // that verdict — the planner also changes nothing while it waits out a
        // shed grace — and reading it as "nothing left to shed" is what opened
        // hard-cap incidents, and fired the owner's Flow, with kilowatts still
        // reducible.
        this.lastRebuild = { atMs: dispatchedAtMs, powerW: signal.currentPowerW, hardCapBreach: signal.hardCapBreach };
        if (this.observedDuringFlight(observationSeqAtDispatch)) {
          this.settleAfterOvertakenRebuild(trigger, outcome);
        } else {
          this.updateTightSuppression(trigger, outcome);
          this.suppressionInvalidated = false;
        }
        this.inFlight = null;
        deferred.resolve(undefined);
      });
  }

  /** Drop the queued rebuild; whoever awaited it learns why. */
  cancel(reason: string): void {
    if (this.queued === null) return;
    this.queued.deferred.resolve(reason);
    this.queued = null;
  }

  /**
   * What a device observation is allowed to do to the rebuild schedule.
   *
   * An observation is not a rebuild trigger (`lib/plan/planRebuildTrigger.ts`) —
   * it changes WHETHER the next whole-home reading decides, never WHAT it
   * decides from. Two gates skip rebuilds that provably cannot change anything,
   * and both derive that verdict from the device set as it was: the shortfall
   * throttle (a plan proved nothing more can be shed) and the tight-noop holdoff
   * (a tight rebuild changed nothing). A device that just turned on adds a
   * controllable load; one that turned off freed the headroom a restore needs.
   * Either way "nothing is actionable" is a verdict about a house that no longer
   * exists, so both are cleared — and the counter is bumped so the clear
   * survives a rebuild already in flight, whose completion would otherwise
   * re-install them on the strength of devices it read before this observation.
   *
   * A `mitigation` holdoff is deliberately kept: it lets a tight rebuild's own
   * action land before PELS decides again, and this observation is frequently
   * that action landing. The 15 s execution floor (`lastDecisionUnactionable`)
   * is kept too — a CPU bound on rebuild frequency, not a claim about the house.
   */
  onObservation(): void {
    this.suppressionInvalidated = true;
    this.noopStreak = 0;
    if (this.holdoff !== null && this.holdoff.cause === 'noop') this.holdoff = null;
    this.observationSeq += 1;
  }

  /**
   * When a queued power intent may run. The execution floor: while the last
   * decision proved nothing actionable, no trigger may execute a rebuild within
   * 15 s of the last one — anchored to that rebuild so `now` deterministically
   * passes it, and never applied before a first rebuild exists.
   */
  dueAtMs(intent: RebuildIntent, nowMs: number): number {
    const floorMs = this.lastDecisionUnactionable && this.lastRebuild !== null
      ? this.lastRebuild.atMs + TIGHT_UNACTIONABLE_MIN_REBUILD_INTERVAL_MS
      : Number.NEGATIVE_INFINITY;
    if (intent.kind === 'hardCap') return Math.max(nowMs, floorMs);
    return Math.max(this.queued === null ? nowMs : this.queued.dueMs, floorMs);
  }

  private memory(): PlanRebuildThrottleMemory {
    return {
      lastRebuild: this.lastRebuild,
      noopStreak: this.noopStreak,
      holdoff: this.holdoff,
      suppressionInvalidated: this.suppressionInvalidated,
      observationSeq: this.observationSeq,
      lastDecisionUnactionable: this.lastDecisionUnactionable,
    };
  }

  private decide(
    signal: PowerRebuildSignal,
    posture: PlanRebuildPosture,
    guard: ThrottleCapacityGuardView,
  ): Promise<void | string> {
    const cadence = POWER_SAMPLE_REBUILD_CADENCE;
    const now = this.deps.getNowMs();
    const maxIntervalExceeded = cadence.maxIntervalMs > 0
      && (this.lastRebuild === null || now - this.lastRebuild.atMs >= cadence.maxIntervalMs);
    // Nothing actionable in shortfall: a rebuild cannot change any action, so
    // hold to the max-interval cadence — but never longer, so a device that
    // returned load without a power signal is still re-discovered — and hand the
    // guard the reading it would otherwise only get from the rebuild, so the
    // latched incident's recovery clock and alert condition keep moving. A
    // reading, not a verdict: the guard judges it against the last plan's.
    if (
      posture.shortfallUnrecoverable
      && !this.suppressionInvalidated
      && signal.isInShortfall
      && !signal.planConvergenceActive
      && !maxIntervalExceeded
    ) {
      incPerfCounter('plan_rebuild_skipped_shortfall_unrecoverable_total');
      return guard.recordReading(signal.totalKw, signal.shortfallThresholdKw);
    }
    const memory = this.memory();
    const decision = resolveRebuildDecision(signal, memory, now, cadence.maxIntervalMs);
    if (!decision.shouldRebuild) {
      this.recordSkip(signal, decision, now);
      // Deliberately NOT telling the guard anything from a throttled skip: entering
      // shortfall without a rebuild having observed the live device state would
      // let a stale "unactionable" summary keep suppressing rebuilds — a device
      // that returned load could then never be discovered. Shortfall entry and
      // clear ride the max-interval rebuild instead.
      return Promise.resolve();
    }
    return this.request(signal, decision, resolveRebuildReason(signal, memory, decision), now);
  }

  private recordSkip(signal: PowerRebuildSignal, decision: RebuildDecision, nowMs: number): void {
    const breached = signal.hardCapBreach.breached;
    if (!decision.headroomTight && !signal.isInShortfall && !breached && this.hasBackoffState()) {
      this.resetBackoff();
    }
    if (!breached && this.lastRebuild !== null && this.lastRebuild.hardCapBreach.breached) {
      this.lastRebuild = { ...this.lastRebuild, hardCapBreach: NO_BREACH };
    }
    // Kept in sync on skips too, so a recovered state cannot carry an old floor forward.
    this.lastDecisionUnactionable = decision.tightUnactionable;
    incPerfCounters([
      'plan_rebuild_skipped_total',
      decision.deltaMeaningful
        ? 'plan_rebuild_skipped_non_boundary_delta_total'
        : 'plan_rebuild_skipped_insignificant_total',
    ]);
    if (decision.backoffActive) {
      incPerfCounter('plan_rebuild_skipped_tight_noop_backoff_total');
      if (this.holdoff !== null && this.holdoff.cause === 'mitigation' && nowMs < this.holdoff.untilMs) {
        incPerfCounter('plan_rebuild_skipped_tight_mitigation_holdoff_total');
      }
    }
  }

  private request(
    signal: PowerRebuildSignal,
    decision: RebuildDecision,
    trigger: PowerSampleRebuildTrigger,
    nowMs: number,
  ): Promise<void | string> {
    // Staged before the scheduler hears of it, because the scheduler may execute
    // synchronously; restored whole if the scheduler drops the intent.
    const queuedBefore = this.queued;
    const noopStreakBefore = this.noopStreak;
    const holdoffBefore = this.holdoff;
    const lastDecisionUnactionableBefore = this.lastDecisionUnactionable;
    if (decision.deltaMeaningful && this.hasBackoffState()) this.resetBackoff();
    const intentKind = resolveRebuildIntentKind(signal.hardCapBreach);
    const earliestMs = this.lastRebuild === null
      ? nowMs
      : this.lastRebuild.atMs + POWER_SAMPLE_REBUILD_CADENCE.minIntervalMs;
    const dueMs = intentKind === 'hardCap' ? nowMs : Math.max(nowMs, earliestMs);
    const previous = this.queued;
    const queued: QueuedRebuild = {
      dueMs: previous === null ? dueMs : Math.min(previous.dueMs, dueMs),
      trigger,
      signal,
      deferred: previous === null ? createDeferred() : previous.deferred,
    };
    this.queued = queued;
    this.lastDecisionUnactionable = decision.tightUnactionable;
    if (intentKind === 'hardCap' && this.hasBackoffState()) this.resetBackoff();

    // The scheduler may execute this request synchronously — which takes it off
    // the queue — so everything below reads the staged record, not the field.
    if (this.deps.getScheduler().request({ kind: intentKind, reason: trigger }) === 'dropped') {
      this.queued = queuedBefore;
      this.noopStreak = noopStreakBefore;
      this.holdoff = holdoffBefore;
      this.lastDecisionUnactionable = lastDecisionUnactionableBefore;
      return this.pendingOrInFlight();
    }
    incPerfCounters(['plan_rebuild_requested_total', 'plan_rebuild_requested.power_sample_total']);
    incReasonCounter('plan_rebuild_requested.power_sample_reason', trigger);
    if (previous === null) incPerfCounter('plan_rebuild_pending_created_total');
    else if (queued.dueMs < previous.dueMs) incPerfCounter('plan_rebuild_pending_rescheduled_total');
    else incPerfCounter('plan_rebuild_pending_coalesced_total');
    return queued.deferred.promise;
  }

  private pendingOrInFlight(): Promise<void | string> {
    if (this.queued !== null) return this.queued.deferred.promise;
    if (this.inFlight !== null) return this.inFlight;
    return Promise.resolve();
  }

  private hasBackoffState(): boolean {
    return this.noopStreak > 0 || this.holdoff !== null;
  }

  private resetBackoff(): void {
    if (this.hasBackoffState()) incPerfCounter('plan_rebuild_tight_noop_backoff_reset_total');
    this.noopStreak = 0;
    this.holdoff = null;
  }

  private observedDuringFlight(seqAtDispatch: number): boolean {
    return this.observationSeq !== seqAtDispatch;
  }

  private updateTightSuppression(trigger: PlanRebuildTrigger, outcome: RebuildOutcome): void {
    // A failed build backs off like a no-op, without the mitigation holdoff: it
    // acted on nothing, so there is no command to let settle. Resetting the
    // backoff instead would let a planner that fails on every build re-run at
    // the minimum cadence for as long as the house stays tight. The caller still
    // spends the invalidation latch, so a failed re-check cannot disarm the
    // shortfall throttle for the rest of the incident.
    if (outcome.failed) {
      this.updateTightSuppressionAfterFailure(trigger);
      return;
    }
    const nowMs = this.deps.getNowMs();
    if (shouldApplyTightMitigationHoldoff(trigger, outcome)) {
      this.resetBackoff();
      this.holdoff = { untilMs: nowMs + TIGHT_MITIGATION_HOLDOFF_MS, cause: 'mitigation' };
      return;
    }
    if (!shouldApplyTightNoopBackoff(trigger, outcome)) {
      this.resetBackoff();
      return;
    }
    this.noopStreak += 1;
    incPerfCounter('plan_rebuild_tight_noop_total');
    incPerfCounter(`plan_rebuild_tight_noop_streak.${Math.min(this.noopStreak, 4)}_total`);
    this.holdoff = { untilMs: nowMs + resolveTightNoopBackoffMs(this.noopStreak), cause: 'noop' };
  }

  private updateTightSuppressionAfterFailure(trigger: PlanRebuildTrigger): void {
    if (!isTightReason(trigger)) {
      this.resetBackoff();
      return;
    }
    this.noopStreak = Math.max(1, this.noopStreak);
    this.holdoff = { untilMs: this.deps.getNowMs() + resolveTightNoopBackoffMs(this.noopStreak), cause: 'noop' };
  }

  /**
   * The settle-down for a rebuild an observation overtook. It keeps the
   * observation's cleared suppressions, and still arms the post-mitigation
   * holdoff when the rebuild actually acted — a tight rebuild's own command echo
   * is exactly the kind of observation that lands mid-flight, and without this
   * the next poll re-decides on top of a command still taking effect. What it
   * never does is install the tight-NOOP backoff or spend the invalidation
   * latch: both rest on a verdict the observation just falsified.
   */
  private settleAfterOvertakenRebuild(trigger: PlanRebuildTrigger, outcome: RebuildOutcome): void {
    if (!shouldApplyTightMitigationHoldoff(trigger, outcome)) return;
    // The overtaking observation already cleared any `noop` holdoff, so this is
    // the only clock left — the same 15 s the un-overtaken path arms.
    this.holdoff = { untilMs: this.deps.getNowMs() + TIGHT_MITIGATION_HOLDOFF_MS, cause: 'mitigation' };
  }
}
