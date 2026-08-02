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
  /** The daily budget in force right now, for the lowering guard. `undefined` = feature off/unreadable. */
  getAppliedDailyBudgetKwh?: () => number | undefined;
  /** Notifies setup that the auto-apply landed so it can fire the Flow trigger; see WeatherCollectorDeps. */
  onDailyBudgetAutoApplied?: (info: { budgetKwh: number; forecastMeanTempC: number }) => void;
  logger: PinoLogger;
};

/**
 * Auto-apply is asymmetric on purpose: it may raise the budget freely, but it
 * may not TIGHTEN one the home has demonstrably been running past. The model can
 * read low for reasons it cannot see (an away stretch inside the fit window, a
 * new load, an occupancy change), and lowering on top of that compounds the harm
 * rather than correcting it. Raising stays unguarded — over-covering costs the
 * owner some money, under-covering costs them heat.
 *
 * The gate is the budget-pressure term, NOT `budgetMayBeLimiting`. That flag
 * only says devices were held back, which is the ordinary state of a home whose
 * daily budget is doing its job; gating on it would make auto-apply a one-way
 * ratchet that could only ever raise the budget until it stopped binding at all,
 * overriding an owner who set a tight budget deliberately. A live pressure term
 * is the stronger claim — recent days actually ran PAST their budget while being
 * held back — and it decays on its own once that stops.
 */
type LoweringGuard = {
  /** Non-null blocks the apply and names the reason in the skip log. */
  reason: 'would_lower_while_limiting' | null;
  currentKwh: number | null;
};

function resolveLoweringGuard(
  state: WeatherHistoryState,
  deps: AutoApplyDeps,
): LoweringGuard {
  const suggestion = state.latestSuggestion;
  // Read the budget ONCE and carry it to the log: re-reading it there would
  // record a comparison that never happened if the value moved in between, and
  // the point of the event is to be the record of this decision.
  const currentKwh = deps.getAppliedDailyBudgetKwh?.();
  if (currentKwh === undefined || !Number.isFinite(currentKwh)) return { reason: null, currentKwh: null };
  if (!suggestion || suggestion.suggestedBudgetKwh >= currentKwh) return { reason: null, currentKwh };
  // Read the ACCUMULATOR, not `suggestion.budgetPressureKwh`. That field is the
  // term's post-clamp contribution to the displayed number, so it reads 0
  // whenever a floor, the hard cap, or the 20 kWh minimum set the suggestion
  // instead — which is exactly when the loop is most active. Gating on it
  // disarmed this guard for the very home it was written for.
  if ((state.budgetPressure?.kwh ?? 0) > 0) return { reason: 'would_lower_while_limiting', currentKwh };
  return { reason: null, currentKwh };
}

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
  const loweringGuard = resolveLoweringGuard(state, deps);
  if (loweringGuard.reason !== null) {
    deps.logger.info({
      event: 'weather_advisor_budget_auto_apply_skipped',
      dateKey: suggestion.targetDateKey,
      reason: loweringGuard.reason,
      toKwh: suggestion.suggestedBudgetKwh,
      currentKwh: loweringGuard.currentKwh,
    });
    return state;
  }
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
