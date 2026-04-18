import type { PowerTrackerState } from '../core/powerTracker';
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
