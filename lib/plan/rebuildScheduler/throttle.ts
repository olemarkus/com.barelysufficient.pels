import type CapacityGuard from '../../power/capacityGuard';
import { buildNullCapacityStateSummary } from '../../power/capacityStateSummary';
import { addPerfDuration, incPerfCounter, incPerfCounters } from '../../utils/perfCounters';
import type { PlanRebuildTrigger, PowerSampleRebuildTrigger } from '../planRebuildTrigger';
import {
  isTightNoopOutcome,
  isTightReason,
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
  resolveHeadroomTight,
  type AdmittedPowerReading,
  type HardCapBreach,
  type PlanRebuildPosture,
  type PowerRebuildSignal,
  type RebuildCadence,
} from './rebuildSignal';
import type { PlanRebuildScheduler, RebuildIntent } from './scheduler';
import type { LastRebuild, PlanRebuildThrottleMemory, RebuildHoldoff } from './throttleMemory';

export {
  initialPlanRebuildThrottleMemory,
  type LastRebuild,
  type PlanRebuildThrottleMemory,
  type RebuildHoldoff,
} from './throttleMemory';

const NO_BREACH: HardCapBreach = { breached: false, deficitKw: 0 };

/** Read-only view for diagnostics and specs: the memory plus the live work. */
export type PlanRebuildThrottleSnapshot = PlanRebuildThrottleMemory & {
  queued: {
    dueMs: number;
    trigger: PowerSampleRebuildTrigger;
    signal: PowerRebuildSignal;
    /** What every sample that joined this request is awaiting. */
    promise: Promise<void | string>;
  } | null;
  inFlight: boolean;
};

type RebuildDeferred = {
  promise: Promise<void | string>;
  resolve: (value: string | undefined) => void;
  reject: (error: Error) => void;
};

/** The ONE rebuild waiting for its due time; later samples coalesce into it. */
type QueuedRebuild = {
  dueMs: number;
  trigger: PowerSampleRebuildTrigger;
  signal: PowerRebuildSignal;
  deferred: RebuildDeferred;
};

export type PlanRebuildThrottleDeps = {
  /** Late-bound: the scheduler's `executeIntent` calls back into this throttle. */
  getScheduler: () => PlanRebuildScheduler;
  getCapacityGuard: () => CapacityGuard;
  getNowMs: () => number;
  rebuildPlanFromCache: (trigger: PowerSampleRebuildTrigger) => Promise<RebuildOutcome | void>;
};

const createDeferred = (): RebuildDeferred => {
  let resolve!: (value: string | undefined) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void | string>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const resolveEffectiveMinIntervalMs = (signal: PowerRebuildSignal, cadence: RebuildCadence): number => {
  const boundaryActive = signal.planConvergenceActive
    || resolveHeadroomTight(signal.headroomKw)
    || signal.isInShortfall
    || signal.hardCapBreach.breached;
  const effectiveMinIntervalMs = boundaryActive
    ? cadence.minIntervalMs
    : Math.max(cadence.minIntervalMs, cadence.stableMinIntervalMs);
  if (effectiveMinIntervalMs > cadence.minIntervalMs) {
    incPerfCounter('plan_rebuild_signal_stable_interval_total');
  }
  return effectiveMinIntervalMs;
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

  constructor(
    private readonly deps: PlanRebuildThrottleDeps,
    private readonly cadence: RebuildCadence,
    memory: PlanRebuildThrottleMemory,
  ) {
    this.restore(memory);
  }

  snapshot(): PlanRebuildThrottleSnapshot {
    return {
      ...this.memory(),
      queued: this.queued === null
        ? null
        : {
          dueMs: this.queued.dueMs,
          trigger: this.queued.trigger,
          signal: this.queued.signal,
          promise: this.queued.deferred.promise,
        },
      inFlight: this.inFlight !== null,
    };
  }

  /**
   * Take on a memory — the constructor's seed, and nothing else in production.
   * Private on purpose: the class owns its memory. A spec that must put a live
   * throttle into a known memory reaches it by element access
   * (`throttle['restore'](memory)`, root `AGENTS.md` testing rules), so a
   * production rename still breaks the spec.
   */
  private restore(memory: PlanRebuildThrottleMemory): void {
    this.lastRebuild = memory.lastRebuild;
    this.noopStreak = memory.noopStreak;
    this.holdoff = memory.holdoff;
    this.suppressionInvalidated = memory.suppressionInvalidated;
    this.observationSeq = memory.observationSeq;
    this.lastDecisionUnactionable = memory.lastDecisionUnactionable;
  }

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
    return this.onSignal(signal, posture).finally(() => {
      addPerfDuration('power_sample_rebuild_ms', Date.now() - rebuildStart);
    });
  }

  /**
   * The signal-level entry: `onSample` with the reading already resolved (specs
   * vary one field at a time). One path from here: the latch rule and the gates
   * are not repeated anywhere else.
   */
  onSignal(signal: PowerRebuildSignal, posture: PlanRebuildPosture): Promise<void | string> {
    // A sample taken outside shortfall spends the latch before deciding. Kept
    // from the free-function version as is: it means an observation's re-check
    // only lands on a sample taken inside shortfall, although the unactionable
    // gate the latch lifts can hold outside it too. Narrowing that is a
    // behaviour change, not this refactor's.
    if (!signal.isInShortfall) this.suppressionInvalidated = false;
    return this.decide(signal, posture, this.deps.getCapacityGuard());
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
      .then(async (outcome) => {
        // A tight no-op under a hard-cap breach still owes the guard the deficit:
        // it decided from THIS reading, and a breach the guard never hears about
        // is indistinguishable from no breach.
        if (isTightNoopOutcome(trigger, outcome) && signal.hardCapBreach.breached && !signal.isInShortfall) {
          await this.deps.getCapacityGuard().checkShortfall({
            hasCandidates: false,
            deficitKw: signal.hardCapBreach.deficitKw,
            totalKw: signal.totalKw,
            shortfallThresholdKw: signal.shortfallThresholdKw,
            capacityStateSummary: buildNullCapacityStateSummary(),
          });
        }
        this.lastRebuild = { atMs: dispatchedAtMs, powerW: signal.currentPowerW, hardCapBreach: signal.hardCapBreach };
        if (this.observedDuringFlight(observationSeqAtDispatch)) {
          this.settleAfterOvertakenRebuild(trigger, outcome);
        } else {
          this.updateTightSuppression(trigger, outcome);
          this.suppressionInvalidated = false;
        }
        this.inFlight = null;
        deferred.resolve(undefined);
      })
      .catch((error: unknown) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        // No mitigation holdoff on the error path: a failed rebuild acted on
        // nothing, so there is no command to let settle. The latch is still
        // cleared, so a failed re-check cannot disarm the shortfall throttle for
        // the rest of the incident — it stays a true one-shot.
        if (!this.observedDuringFlight(observationSeqAtDispatch)) {
          this.updateTightSuppressionAfterError(trigger);
          this.suppressionInvalidated = false;
        }
        this.inFlight = null;
        deferred.reject(normalizedError);
        throw normalizedError;
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
    if (intent.kind === 'signal') return Math.max(this.queued === null ? nowMs : this.queued.dueMs, floorMs);
    return Number.POSITIVE_INFINITY;
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
    guard: CapacityGuard,
  ): Promise<void | string> {
    const { cadence } = this;
    const now = this.deps.getNowMs();
    const maxIntervalExceeded = cadence.maxIntervalMs > 0
      && (this.lastRebuild === null || now - this.lastRebuild.atMs >= cadence.maxIntervalMs);
    // Nothing actionable in shortfall: a rebuild cannot change any action, so
    // hold to the max-interval cadence — but never longer, so a device that
    // returned load without a power signal is still re-discovered — and give
    // the guard the deficit it would otherwise only learn from the rebuild.
    if (
      posture.shortfallUnrecoverable
      && !this.suppressionInvalidated
      && signal.isInShortfall
      && !signal.planConvergenceActive
      && !maxIntervalExceeded
    ) {
      incPerfCounter('plan_rebuild_skipped_shortfall_unrecoverable_total');
      return Promise.resolve(guard.checkShortfall({
        hasCandidates: false,
        deficitKw: signal.hardCapBreach.deficitKw,
        totalKw: signal.totalKw,
        shortfallThresholdKw: signal.shortfallThresholdKw,
        capacityStateSummary: buildNullCapacityStateSummary(),
      }));
    }
    // Resolved before the decision so its telemetry counts every sample that
    // reached the gates, skipped or not.
    const minIntervalMs = resolveEffectiveMinIntervalMs(signal, cadence);
    const memory = this.memory();
    const decision = resolveRebuildDecision(signal, memory, now, cadence.maxIntervalMs);
    if (!decision.shouldRebuild) {
      this.recordSkip(signal, decision, now);
      // Deliberately NOT driving `checkShortfall` from a throttled skip: entering
      // shortfall without a rebuild having observed the live device state would
      // let a stale "unactionable" summary keep suppressing rebuilds — a device
      // that returned load could then never be discovered. Shortfall entry and
      // clear ride the max-interval rebuild instead.
      return Promise.resolve();
    }
    return this.request(signal, decision, resolveRebuildReason(signal, memory, decision), now, minIntervalMs);
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
    minIntervalMs: number,
  ): Promise<void | string> {
    // Staged before the scheduler hears of it, because the scheduler may execute
    // synchronously; restored whole if the scheduler drops the intent.
    const queuedBefore = this.queued;
    const noopStreakBefore = this.noopStreak;
    const holdoffBefore = this.holdoff;
    const lastDecisionUnactionableBefore = this.lastDecisionUnactionable;
    if (decision.deltaMeaningful && this.hasBackoffState()) this.resetBackoff();
    const intentKind = resolveRebuildIntentKind(signal.hardCapBreach);
    const earliestMs = this.lastRebuild === null ? nowMs : this.lastRebuild.atMs + minIntervalMs;
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
    const requestResult = this.deps.getScheduler().request({ kind: intentKind, reason: trigger });
    if (requestResult.status === 'dropped') {
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

  private updateTightSuppression(trigger: PlanRebuildTrigger, outcome: RebuildOutcome | void): void {
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

  private updateTightSuppressionAfterError(trigger: PlanRebuildTrigger): void {
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
  private settleAfterOvertakenRebuild(trigger: PlanRebuildTrigger, outcome: RebuildOutcome | void): void {
    if (!shouldApplyTightMitigationHoldoff(trigger, outcome)) return;
    // The overtaking observation already cleared any `noop` holdoff, so this is
    // the only clock left — the same 15 s the un-overtaken path arms.
    this.holdoff = { untilMs: this.deps.getNowMs() + TIGHT_MITIGATION_HOLDOFF_MS, cause: 'mitigation' };
  }
}
