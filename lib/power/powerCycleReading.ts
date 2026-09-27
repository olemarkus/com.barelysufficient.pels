import type { PowerTrackerState } from './tracker';
import { resolveMeterEvidenceAtMs, resolveLastTotalPowerKw } from './lastTotalPower';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from './sampleFreshness';

/**
 * What one plan cycle is allowed to know about power: a MEASURED reading, or
 * the fact that the meter has gone silent. Nothing in between.
 *
 * `lib/power` owns the meter, so `lib/power` decides what a doubtful reading
 * means (root `AGENTS.md` → "Clean and trusted interfaces between layers"; the
 * 2026-08-16 ruling that `lib/plan` holds no concept of staleness). Between the
 * 60 s staleness threshold and the 10-minute shed timeout the last good value
 * carries forward AS MEASURED — a transient gap is a no-op, not a hold (owner
 * ruling 2026-08-31). Past the timeout the reading is a `SilentMeterReading`,
 * and the answer is a SIGNAL, never a number: the silent-meter pass used to be
 * expressed as a sentinel `-1` headroom, which every consumer then did
 * arithmetic on (owner ruling 2026-09-02 — never encode "unmeasured" as a
 * magic number; the planner takes an explicit directive instead, and the
 * ordinary pipeline is entered only with a measurement).
 */
export type MeasuredPowerReading = {
  isMeasured: true;
  /** The whole-home draw, signed net (negative on export), kW. */
  totalKw: number;
  lastPowerUpdateMs: number;
  /** The spare room before a limit, kW — negative when above it. */
  headroomKw: (limitKw: number) => number;
};

/**
 * The meter has been silent past the shed timeout. Carries the reading's
 * DISPLAY facts only (the carried total and its stamp, for the plan snapshot's
 * base fields) and no headroom at all: there is nothing to compute with.
 */
export type SilentMeterReading = {
  isMeasured: false;
  totalKw: number;
  lastPowerUpdateMs: number;
};

export type PowerCycleReading = MeasuredPowerReading | SilentMeterReading;

/**
 * The reading's display projection — the reading as this cycle planned on it,
 * written outward onto the plan snapshot and never read back as a control
 * input. Both variants carry it: a plan build exists only behind the
 * measurement gate, so a reading (measured, or carried) always exists. Its
 * stamp is control's evidence stamp; the owner-facing surfaces that warn of
 * missing readings age the displayed one (`resolveDisplayedPowerUpdateMs`).
 */
export type PowerCycleDisplay = {
  totalKw: number;
  lastPowerUpdateMs: number;
};

/**
 * Resolve one plan cycle's reading — pure, no per-home state.
 *
 * The silence policy itself (the plan-build block, the ONE fail-closed pass the
 * silence window is owed, the restart rule) lives in the wiring's composed
 * gate and `lib/power/meterSilence.ts`. This resolver only says which variant
 * the planner is looking at.
 */
export const resolvePowerCycleReading = (params: {
  powerTracker: PowerTrackerState;
  nowMs: number;
}): PowerCycleReading => {
  const { powerTracker, nowMs } = params;
  // The reading is resolved from the tracker's own latch — no separate total
  // parameter to fall out of sync with the freshness stamp, and no nullable
  // to cross the seam. A build without a latched sample is a measurement-gate
  // violation (`lib/power/powerMeasurementGate.ts` holds every ungated home), so
  // it fails loud here instead of planning on a fabricated number.
  const totalKw = resolveLastTotalPowerKw(powerTracker);
  // The age of the newest EVIDENCE, not of the newest delivery: a dead meter
  // behind a live driver keeps delivering its last value, and once the home's
  // metered load has contradicted it for ten minutes that repeat is no more a
  // reading than silence is (`lib/power/heldReading.ts`).
  const lastPowerUpdateMs = resolveMeterEvidenceAtMs(powerTracker);
  if (totalKw === null || lastPowerUpdateMs === undefined) {
    throw new Error('power cycle reading requires a latched sample — a build reached past the measurement gate');
  }
  if (nowMs - lastPowerUpdateMs >= POWER_SAMPLE_STALE_SHED_TIMEOUT_MS) {
    return { isMeasured: false, totalKw, lastPowerUpdateMs };
  }
  return {
    isMeasured: true,
    totalKw,
    lastPowerUpdateMs,
    headroomKw: (limitKw: number): number => limitKw - totalKw,
  };
};
