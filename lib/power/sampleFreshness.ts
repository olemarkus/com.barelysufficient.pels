import type { PowerTrackerState } from './tracker';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
  type PowerFreshnessState,
} from '../../packages/shared-domain/src/powerFreshness';
export {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
  type PowerFreshnessState,
} from '../../packages/shared-domain/src/powerFreshness';

/**
 * How old the meter sample behind this cycle is, and what that age means.
 *
 * Owned by `lib/power` because `lib/power` owns the meter: the layer that reads
 * an untyped source is the layer that decides what a doubtful reading means.
 * Consumers receive the decision, never the ingredients — see the root
 * `AGENTS.md` "Clean and trusted interfaces between layers".
 *
 * This lived in `lib/plan/planPowerFreshness.ts` until 2026-08-16. It was born
 * there as a planner feature ("Add freshness-based planner headroom fallback")
 * back when there was no `lib/power/`; when power tracking was promoted out of
 * `lib/core` the tracker moved and its classifier did not.
 */
export type PowerSampleFreshness = {
  hasLivePowerSample: boolean;
  lastPowerUpdateMs: number | null;
  powerSampleAgeMs: number | null;
  powerFreshnessState: PowerFreshnessState;
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
    return {
      hasLivePowerSample: false,
      lastPowerUpdateMs: null,
      powerSampleAgeMs: null,
      powerFreshnessState: 'stale_hold',
    };
  }

  const powerSampleAgeMs = Math.max(0, nowMs - lastPowerUpdateMs);
  if (powerSampleAgeMs < POWER_SAMPLE_STALE_THRESHOLD_MS) {
    return {
      hasLivePowerSample: true,
      lastPowerUpdateMs,
      powerSampleAgeMs,
      powerFreshnessState: 'fresh',
    };
  }
  if (powerSampleAgeMs < POWER_SAMPLE_STALE_SHED_TIMEOUT_MS) {
    return {
      hasLivePowerSample: false,
      lastPowerUpdateMs,
      powerSampleAgeMs,
      powerFreshnessState: 'stale_hold',
    };
  }

  return {
    hasLivePowerSample: false,
    lastPowerUpdateMs,
    powerSampleAgeMs,
    powerFreshnessState: 'stale_fail_closed',
  };
}
