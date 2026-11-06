import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import type { WeatherCollectorDeps } from './weatherCollectorDeps';
import { readMeterScopeDailyKwh } from './weatherMeterScope';
import { normalizeError } from '../utils/errorUtils';

/**
 * Recover counted observations from the retained tracker history after a scope
 * read succeeds. A completed Insights backfill marker must not prevent this
 * upgrade: Insights has actual totals, while only power accounting knows exemptions.
 * Read at most the latest 31 records; the tracker retains 30 days of hourly evidence.
 */
export function recoverCountedHistory(
  state: WeatherHistoryState,
  readDay: WeatherCollectorDeps['getDailyKwh'],
): WeatherHistoryState {
  const records = state.records.map((record, index) => {
    if (index < state.records.length - 31 || record.kwhBudgetCounted !== undefined) return record;
    const day = readMeterScopeDailyKwh(state, record.dateKey, readDay);
    if (day.budgetCounted === undefined || day.total !== record.kwhTotal) return record;
    return { ...record, kwhBudgetCounted: day.budgetCounted };
  });
  return records.some((record, index) => record !== state.records[index]) ? { ...state, records } : state;
}

/** Recover accounting and refit discarded advice without applying a budget on load. */
export function refreshAccountingHistory(
  state: WeatherHistoryState,
  deps: WeatherCollectorDeps,
): WeatherHistoryState {
  let recovered = state;
  try {
    recovered = recoverCountedHistory(state, deps.getDailyKwh);
  } catch (error) {
    deps.logger.warn({ event: 'weather_accounting_history_unavailable', err: normalizeError(error) });
  }
  if (!recovered.latestFit && !recovered.records.some((record) => record.kwhBudgetCounted !== undefined)) {
    return recovered;
  }
  if (recovered.latestFit?.recentResidualQ80 !== undefined && recovered.latestSuggestion) return recovered;
  return deps.recomputeDerived(recovered);
}
