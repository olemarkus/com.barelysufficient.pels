import {
  emptyObservedHourlyStats,
  type ObservedHourlyStats,
} from '../../lib/dailyBudget/observedHourlyStats';

/**
 * A complete `ObservedHourlyStats` for a spec: nothing observed (24 zeros per
 * series), with the series the spec cares about laid over it.
 */
export const observedHourlyStatsFixture = (
  series: Partial<ObservedHourlyStats> = {},
): ObservedHourlyStats => ({ ...emptyObservedHourlyStats(), ...series });
