import type { Logger as PinoLogger } from 'pino';
import type {
  WeatherAdvisorSettings,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';

/**
 * Weather-insight daily-budget auto-apply. Kept out of the collector so the
 * collector stays a data/scheduling layer: this module owns the decision (opted
 * in? a suggestion to apply?), the injected apply, the audit stamp, and the log.
 *
 * Design of record: `notes/weather-insight-spec.md` + the auto-apply plan.
 */

/** Just the collector deps this needs — declared locally to avoid coupling to WeatherCollectorDeps. */
type AutoApplyDeps = {
  getSettings: () => WeatherAdvisorSettings;
  getNowMs: () => number;
  /** Returns true when applied, false when the daily budget feature is off (leave-off semantics). */
  applySuggestedDailyBudget?: (suggestedKwh: number) => boolean;
  /** Notifies setup that the auto-apply landed so it can fire the Flow trigger; see WeatherCollectorDeps. */
  onDailyBudgetAutoApplied?: (info: { budgetKwh: number; forecastMeanTempC: number }) => void;
  logger: PinoLogger;
};

/**
 * At a completed rollup (state already refit), apply the fresh suggestion to the
 * daily budget when the user opted in. No-op (returns the state unchanged) when
 * auto-apply is off, when there is no suggestion (no fit/forecast → keep the
 * current budget), or when the applier reports the daily budget is disabled.
 * On success, stamps the `lastAutoApply` audit and logs the structured event.
 */
export function performBudgetAutoApply(state: WeatherHistoryState, deps: AutoApplyDeps): WeatherHistoryState {
  const settings = deps.getSettings();
  const suggestion = state.latestSuggestion;
  if (!settings.enabled || !settings.autoApplyDailyBudget || !suggestion) return state;
  // Idempotent per target day: catchUpRollups also runs on collector start (boot
  // and settings-reload), so without this a missed-midnight catch-up could re-apply
  // for a day already applied. The audit doubles as the once-per-day gate.
  if (state.lastAutoApply?.dateKey === suggestion.targetDateKey) return state;
  if (!(deps.applySuggestedDailyBudget?.(suggestion.suggestedBudgetKwh) ?? false)) return state;
  deps.logger.info({
    event: 'weather_advisor_budget_auto_applied',
    dateKey: suggestion.targetDateKey,
    toKwh: suggestion.suggestedBudgetKwh,
  });
  deps.onDailyBudgetAutoApplied?.({
    budgetKwh: suggestion.suggestedBudgetKwh,
    forecastMeanTempC: suggestion.forecastMeanTempC,
  });
  return {
    ...state,
    lastAutoApply: {
      dateKey: suggestion.targetDateKey, kwh: suggestion.suggestedBudgetKwh, appliedAtMs: deps.getNowMs(),
    },
  };
}
