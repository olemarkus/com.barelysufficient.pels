import type { PowerTrackerState } from './tracker';
export {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../packages/shared-domain/src/powerFreshness';

/**
 * How old the meter sample behind this cycle is.
 *
 * Owned by `lib/power` because `lib/power` owns the meter. The old 3-state
 * freshness label is gone (owner ruling 2026-08-31: staleness is a UI-only
 * banner fact, computed client-side from the tracker timestamp; the planner
 * sees only its gate boolean and kW) — what remains is the sample's raw age,
 * for the silence policy and the reading resolver.
 */
export type PowerSampleFreshness = {
  lastPowerUpdateMs: number | null;
  powerSampleAgeMs: number | null;
};

export function resolvePowerSampleFreshness(
  powerTracker: PowerTrackerState,
  nowMs = Date.now(),
): PowerSampleFreshness {
  const rawTimestamp = powerTracker.lastTimestamp;
  const lastPowerUpdateMs: number | null = typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)
    ? rawTimestamp
    : null;
  if (lastPowerUpdateMs === null) {
    return { lastPowerUpdateMs: null, powerSampleAgeMs: null };
  }
  return { lastPowerUpdateMs, powerSampleAgeMs: Math.max(0, nowMs - lastPowerUpdateMs) };
}
