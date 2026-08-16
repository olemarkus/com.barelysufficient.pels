import type { Logger as PinoLogger } from '../logging/logger';
import type { PowerTrackerState } from './tracker';
import { resolvePowerSampleFreshness, type PowerFreshnessState } from './sampleFreshness';

/**
 * What one plan cycle is allowed to know about power.
 *
 * The planner asks `headroomKw` and receives a number. It is never handed the
 * meter total, a freshness label, or a variant to discriminate — `lib/power`
 * owns the meter, so `lib/power` decides what a doubtful reading means and
 * answers in kW (root `AGENTS.md` → "Clean and trusted interfaces between
 * layers"; the 2026-08-16 ruling that `lib/plan` holds no concept of staleness,
 * the twin of `observationStale` being off the plan kinds).
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

  constructor(private readonly structuredLog?: PowerFreshnessLogger) {}

  observe(params: {
    powerTracker: PowerTrackerState;
    /**
     * `null` only when a caller reached a plan build without a measurement,
     * which `setup/powerMeasurementGate.ts` prevents in production. Resolved
     * here, into a held headroom, so the absence stops at this boundary.
     */
    totalKw: number | null;
    nowMs: number;
  }): PowerCycleReading {
    const { powerTracker, totalKw, nowMs } = params;
    const freshness = resolvePowerSampleFreshness(powerTracker, nowMs);
    const state = freshness.powerFreshnessState;
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
      display: {
        totalKw,
        freshnessState: state,
        powerSampleAgeMs: freshness.powerSampleAgeMs,
        lastPowerUpdateMs: freshness.lastPowerUpdateMs,
      },
    };
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
