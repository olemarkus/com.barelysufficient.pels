import type { Logger as PinoLogger } from '../logging/logger';
import type { PowerTrackerState } from './tracker';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  resolvePowerSampleFreshness,
  type PowerFreshnessState,
} from './sampleFreshness';

/**
 * What one plan cycle is allowed to know about power.
 *
 * The planner asks `headroomKw` and receives a number. It is never handed the
 * meter total, a freshness label, or a variant to discriminate — `lib/power`
 * owns the meter, so `lib/power` decides what a doubtful reading means and
 * answers in kW (root `AGENTS.md` → "Clean and trusted interfaces between
 * layers"; the 2026-08-16 ruling that `lib/plan` holds no concept of staleness,
 * the twin of the plan kinds carrying no device-observation freshness).
 *
 * `display` is the other direction: facts the owner is entitled to see (the
 * hero's "Power readings have dropped"), written outward onto the plan snapshot
 * and never read back as a control input. It is deliberately a separate member
 * so a planner branch cannot reach a freshness label by accident.
 */
export type PowerCycleReading = {
  headroomKw: (limitKw: number) => number;
  /**
   * Whether this cycle's numbers come from a reading rather than from the
   * producer's synthesized hold — the one thing a headroom cannot say about
   * itself, since a measured 0 kW and a held 0 kW are the same number.
   *
   * Resolved ONCE, here. This is not the `powerKnown` boolean deleted on
   * 2026-08-07: that one was re-derived by each consumer from a raw total plus a
   * freshness label, which is the provenance branch the root `AGENTS.md` forbids.
   * This says only "measured or not" and never why — no `stale_hold` versus
   * `stale_fail_closed`, no age, nothing to interpret. A consumer that wants the
   * reason is asking the wrong layer.
   */
  isMeasured: boolean;
  /**
   * Whether the house is MEASURED to be drawing at or below `thresholdKw`.
   *
   * False whenever the meter cannot be trusted — "we did not see it" and "it is
   * above" are the same answer to a caller that may only act on a positive. It
   * exists because two planner decisions need a measurement rather than a
   * difference (is capacity actually the binding constraint; is the house
   * genuinely idle in an exhausted hour), and both would otherwise have to
   * reconstruct one from a total plus a freshness label.
   */
  measuredAtOrBelowKw: (thresholdKw: number) => boolean;
  /**
   * The complement of `measuredAtOrBelowKw`: MEASURED to be drawing above the
   * limit. Not `!measuredAtOrBelowKw` — an unmeasured cycle is false for both,
   * which is why the two exist separately rather than as one predicate a caller
   * negates. Three sites used to hand-compose this from a boolean and a total.
   */
  measuredAboveKw: (limitKw: number) => boolean;
  display: PowerCycleDisplay;
};

export type PowerCycleDisplay = {
  /**
   * The meter total behind this cycle, for display only.
   *
   * Nullable HERE and nowhere downstream of here: it is the producer's own
   * statement about its own reading, and `null` is only reachable when a caller
   * drives a plan build without going through the measurement gate (in
   * production, nothing does). It never becomes a planning input — the planner's
   * surface above is numbers, so no consumer can spend an absent total by
   * forgetting to check for one.
   */
  totalKw: number | null;
  /**
   * The total PLANNING may use: the reading when it is trustworthy, `null` when
   * there is none. Resolved ONCE, here — consumers must not recombine
   * `isMeasured` with `totalKw` for themselves, which is the raw-total-plus-flag
   * shape deleted on 2026-08-07 and easy to reintroduce one site at a time.
   */
  measuredTotalKw: number | null;
  /** Producer-resolved; consumers must not test `freshnessState === 'fresh'`. */
  hasLiveSample: boolean;
  freshnessState: PowerFreshnessState;
  powerSampleAgeMs: number | null;
  lastPowerUpdateMs: number | null;
};

/**
 * Synthesized headroom when the meter cannot be trusted. Not a measurement —
 * a decision, and the meter's owner is the only layer entitled to make it.
 * `stale_hold` holds (admit nothing, force nothing); `stale_fail_closed` sheds.
 */
const FAIL_CLOSED_HEADROOM_KW = -1;
const HOLD_HEADROOM_KW = 0;

export type PowerFreshnessLogger = Pick<PinoLogger, 'info' | 'warn'>;

/**
 * Resolves one cycle's reading and owns the freshness state machine, including
 * its transition logs.
 *
 * Per home: the state is "what did this meter read like last cycle", and a
 * shared instance would cross-talk between a main home and its meter areas.
 * Only the plan-build path calls `observe`, so a transition is logged once per
 * rebuild — `resolvePowerSampleFreshness` stays available, and silent, for
 * read-only callers.
 */
export class PowerFreshnessMonitor {
  private lastState: PowerFreshnessState | null = null;

  /**
   * When this monitor first looked. The escalation to `stale_fail_closed` is
   * measured from HERE as well as from the sample, because the sample timestamp
   * outlives the process: `loadPowerTrackerState` restores it across a restart,
   * so a Homey reboot after any gap longer than the timeout would otherwise
   * resolve fail-closed on the very first build — shedding the whole house blind
   * before the first 10-second poll had a chance to land. The producer must not
   * reach a conclusion it has not waited for.
   *
   * Seeded from app start where the caller knows it, so the window is "how long
   * has PELS been able to observe", not "how long since the first plan build" —
   * a home whose first build happens late must not get a fresh grace.
   */
  private observingSinceMs: number | null = null;

  constructor(
    private readonly structuredLog?: PowerFreshnessLogger,
    /**
     * When PELS became able to observe. Read lazily rather than captured, so a
     * caller that learns its start time after construction is not silently
     * ignored. Falls back to the first `observe` when absent.
     */
    private readonly getObservingSinceMs?: () => number,
  ) {}

  observe(params: {
    powerTracker: PowerTrackerState;
    /**
     * `null` only when a caller reached a plan build without a measurement,
     * which `lib/power/powerMeasurementGate.ts` prevents in production. Resolved
     * here, into a held headroom, so the absence stops at this boundary.
     */
    totalKw: number | null;
    nowMs: number;
  }): PowerCycleReading {
    const { powerTracker, totalKw, nowMs } = params;
    this.observingSinceMs = this.getObservingSinceMs?.() ?? this.observingSinceMs ?? nowMs;
    const freshness = resolvePowerSampleFreshness(powerTracker, nowMs);
    const state = this.holdWhileStillWaiting(freshness.powerFreshnessState, nowMs);
    this.emitTransitionLogs(state, freshness.powerSampleAgeMs);
    this.lastState = state;
    const measured = state === 'fresh' && totalKw !== null;

    return {
      isMeasured: measured,
      headroomKw: (limitKw: number): number => {
        if (measured && totalKw !== null) return limitKw - totalKw;
        return state === 'stale_fail_closed' ? FAIL_CLOSED_HEADROOM_KW : HOLD_HEADROOM_KW;
      },
      measuredAtOrBelowKw: (thresholdKw: number): boolean => (
        measured && totalKw !== null && totalKw <= thresholdKw
      ),
      measuredAboveKw: (limitKw: number): boolean => (
        measured && totalKw !== null && totalKw > limitKw
      ),
      display: {
        totalKw,
        measuredTotalKw: measured ? totalKw : null,
        hasLiveSample: freshness.hasLivePowerSample,
        freshnessState: state,
        powerSampleAgeMs: freshness.powerSampleAgeMs,
        lastPowerUpdateMs: freshness.lastPowerUpdateMs,
      },
    };
  }

  /**
   * Downgrade a fail-closed verdict to a hold until this monitor has itself been
   * watching for the full timeout.
   *
   * Only reachable with a sample timestamp that predates the process — i.e. a
   * restart. A home that has never sampled at all already resolves to
   * `stale_hold` and has no age to escalate on, so this does not change it; a
   * home sampling normally is fresh and never reaches here. What it removes is
   * the restart blind-shed, and nothing else.
   */
  private holdWhileStillWaiting(state: PowerFreshnessState, nowMs: number): PowerFreshnessState {
    if (state !== 'stale_fail_closed') return state;
    const observingForMs = nowMs - (this.observingSinceMs ?? nowMs);
    return observingForMs >= POWER_SAMPLE_STALE_SHED_TIMEOUT_MS ? state : 'stale_hold';
  }

  /**
   * The two ladders are INDEPENDENT, as they were when this lived in
   * `planBuilderMeta`: a `stale_hold` → `stale_fail_closed` step emits both the
   * hold's `_cleared` and the fail-closed's `_entered`. Collapsing them into one
   * else-if chain would silently drop a log line that `pels-log-review` and
   * saved queries read.
   */
  private emitTransitionLogs(state: PowerFreshnessState, powerSampleAgeMs: number | null): void {
    this.emitLadderTransition(state, powerSampleAgeMs, 'stale_hold', HOLD_HEADROOM_KW);
    this.emitLadderTransition(state, powerSampleAgeMs, 'stale_fail_closed', FAIL_CLOSED_HEADROOM_KW);
  }

  private emitLadderTransition(
    state: PowerFreshnessState,
    powerSampleAgeMs: number | null,
    ladder: 'stale_hold' | 'stale_fail_closed',
    syntheticHeadroomKw: number,
  ): void {
    const previous = this.lastState;
    if (previous !== ladder && state === ladder) {
      this.structuredLog?.warn?.({
        event: `power_sample_${ladder}_entered`,
        powerSampleAgeMs,
        syntheticHeadroomKw,
      });
    } else if (previous === ladder && state !== ladder) {
      this.structuredLog?.info?.({ event: `power_sample_${ladder}_cleared`, powerSampleAgeMs });
    }
  }
}
