export const POWER_SAMPLE_STALE_THRESHOLD_MS = 60 * 1000;
export const POWER_SAMPLE_STALE_SHED_TIMEOUT_MS = 10 * 60 * 1000;

export type PowerFreshnessState = 'fresh' | 'stale_hold' | 'stale_fail_closed';
