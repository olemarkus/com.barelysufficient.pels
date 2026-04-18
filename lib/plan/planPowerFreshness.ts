import type { PowerTrackerState } from '../core/powerTracker';

export const POWER_SAMPLE_STALE_THRESHOLD_MS = 60 * 1000;
export const POWER_SAMPLE_STALE_SHED_TIMEOUT_MS = 10 * 60 * 1000;

export type PowerFreshnessState = 'fresh' | 'stale_hold' | 'stale_fail_closed';

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
