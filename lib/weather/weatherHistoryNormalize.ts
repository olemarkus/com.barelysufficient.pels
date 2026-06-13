import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

/**
 * Normalizers for the persisted "derived" weather-history fields (the fit, the
 * budget suggestion, and the auto-apply audit). Split out of `weatherHistory.ts`
 * to keep that module under its size budget. All three are strip/default — never
 * reject — so a record's irreplaceable temperature history always survives.
 */

/**
 * A stored fit predating the suppression fields must still satisfy the contract
 * (the readout serves it verbatim before the first recompute). Real values win;
 * a missing field defaults to "no suppression" — exactly true of a fit computed
 * before the feature existed.
 */
export function defaultStoredFit(raw: Record<string, unknown>): WeatherHistoryState['latestFit'] {
  return {
    suppressedDaysExcluded: 0,
    suppressionFilterRelaxed: false,
    recentColdSuppressionSuspected: false,
    ...raw,
  } as WeatherHistoryState['latestFit'];
}

export function defaultStoredSuggestion(raw: Record<string, unknown>): WeatherHistoryState['latestSuggestion'] {
  return { budgetMayBeLimiting: false, ...raw } as WeatherHistoryState['latestSuggestion'];
}

/**
 * Auto-apply audit: strip-not-reject. A malformed value is dropped (the record's
 * irreplaceable history must survive), so it must be fully shaped —
 * `{ dateKey, kwh, appliedAtMs }` — or it's discarded.
 */
export function normalizeLastAutoApply(raw: unknown): WeatherHistoryState['lastAutoApply'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { dateKey, kwh, appliedAtMs } = raw as Record<string, unknown>;
  if (typeof dateKey !== 'string' || typeof kwh !== 'number' || typeof appliedAtMs !== 'number') return undefined;
  if (!Number.isFinite(kwh) || !Number.isFinite(appliedAtMs)) return undefined;
  return { dateKey, kwh, appliedAtMs };
}
