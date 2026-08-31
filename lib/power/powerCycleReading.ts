import type { PowerTrackerState } from './tracker';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  resolvePowerSampleFreshness,
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
 * settings UI's no-readings banner derives from its timestamp), written
 * outward onto the plan snapshot and never read back as a control input. It is
 * deliberately a separate member so a planner branch cannot reach a freshness
 * label by accident.
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
  lastPowerUpdateMs: number | null;
};

/**
 * Synthesized headroom for the ONE build that runs while the meter is silent
 * past the shed timeout: the escalation's fail-closed pass. Not a measurement —
 * a decision, and the meter's owner is the only layer entitled to make it.
 * Every other silent-window build is blocked by the wiring's composed gate
 * (`MeterSilenceMonitor`), so this constant is how the single pass sheds.
 */
const FAIL_CLOSED_HEADROOM_KW = -1;
/**
 * Defensive only: reachable when a caller reaches a build with no measurement,
 * which the measurement gate prevents in production.
 */
const HOLD_HEADROOM_KW = 0;

/**
 * Resolve one plan cycle's reading — pure, no per-home state.
 *
 * The old 3-state freshness ladder (`stale_hold`'s 0 kW synthesis, the
 * monitor's transition logs, the restart grace) is gone (owner ruling
 * 2026-08-31): between the 60 s staleness threshold and the 10-minute shed
 * timeout the last good value carries forward AS MEASURED — a transient gap
 * is a no-op, not a hold — and past the timeout the wiring blocks new builds
 * outright (`lib/power/meterSilence.ts`, which also owns the restart rule
 * that replaced `holdWhileStillWaiting`). What remains here is the one
 * decision the reading's owner still makes: the escalation's single
 * fail-closed pass resolves −1 kW so it sheds without the planner ever
 * learning why.
 */
export const resolvePowerCycleReading = (params: {
  powerTracker: PowerTrackerState;
  /**
   * `null` only when a caller reached a plan build without a measurement,
   * which `lib/power/powerMeasurementGate.ts` prevents in production. Resolved
   * here, into a held headroom, so the absence stops at this boundary.
   */
  totalKw: number | null;
  nowMs: number;
}): PowerCycleReading => {
  const { powerTracker, totalKw, nowMs } = params;
  const freshness = resolvePowerSampleFreshness(powerTracker, nowMs);
  const silent = freshness.powerSampleAgeMs !== null
    && freshness.powerSampleAgeMs >= POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
  // A total with NO timestamp cannot be judged silent-or-not, so it is not
  // spendable: production ingest always stamps both together, so this arm is
  // only reachable by a gate-bypassing caller — the same family as the
  // null-total hold below.
  const measured = !silent && totalKw !== null && freshness.lastPowerUpdateMs !== null;

  return {
    isMeasured: measured,
    headroomKw: (limitKw: number): number => {
      if (measured && totalKw !== null) return limitKw - totalKw;
      return silent ? FAIL_CLOSED_HEADROOM_KW : HOLD_HEADROOM_KW;
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
      lastPowerUpdateMs: freshness.lastPowerUpdateMs,
    },
  };
};
