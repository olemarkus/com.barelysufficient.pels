import { getDateKeyStartMs, getNextLocalDayStartUtcMs } from '../../packages/shared-domain/src/utils/dateUtils';
import { normalizeError } from '../utils/errorUtils';
import type { BudgetAdviceDecision } from '../../packages/contracts/src/budgetDiagnostics';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import { planningPowerCeiling } from '../../packages/shared-domain/src/settings/powerLimits';
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
  /** The daily budget in force right now, for the decision journal. `undefined` = feature off/unreadable. */
  getAppliedDailyBudgetKwh?: () => number | undefined;
  /** Notifies setup that the auto-apply landed so it can fire the Flow trigger; see WeatherCollectorDeps. */
  onDailyBudgetAutoApplied?: (info: { budgetKwh: number; forecastMeanTempC: number }) => void;
  /** The live power-limit settings; the recorded daily ceiling is their planning ceiling. */
  getPowerLimitSettings: () => PowerLimitSettings;
  getTimeZone: () => string;
  recordBudgetDecision?: (decision: BudgetAdviceDecision) => void;
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
  if (!settings.enabled || !suggestion) return state;
  // Idempotent per target day: catchUpRollups also runs on collector start (boot
  // and settings-reload), so without this a missed-midnight catch-up could re-apply
  // for a day already applied. The audit doubles as the once-per-day gate.
  if (state.lastAutoApply?.dateKey === suggestion.targetDateKey) return state;
  if (!settings.autoApplyDailyBudget) {
    recordDecision(state, deps, 'auto_apply_off', null);
    return state;
  }
  // The recommendation already includes demand correction; allow it to move both ways.
  const currentKwh = deps.getAppliedDailyBudgetKwh?.() ?? null;
  if (!(deps.applySuggestedDailyBudget?.(suggestion.suggestedBudgetKwh) ?? false)) {
    recordDecision(state, deps, 'budget_disabled_or_unavailable', currentKwh);
    return state;
  }
  recordDecision(state, deps, 'applied', currentKwh);
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

/** Journal failure is observational and must not prevent an authorized budget apply. */
function recordDecision(
  state: WeatherHistoryState,
  deps: AutoApplyDeps,
  outcome: BudgetAdviceDecision['outcome'],
  budgetBeforeKwh: number | null,
): void {
  const suggestion = state.latestSuggestion;
  if (!suggestion || !deps.recordBudgetDecision) return;
  try {
    deps.recordBudgetDecision({
      budgetAlgorithmVersion: 2,
      recordedAtMs: deps.getNowMs(),
      targetDateKey: suggestion.targetDateKey,
      meterScopeSignature: state.meterScopeSignature ?? null,
      outcome,
      budgetBeforeKwh: outcome === 'auto_apply_off' ? readAppliedBudget(deps) : budgetBeforeKwh,
      budgetAfterKwh: outcome === 'applied' ? readAppliedBudget(deps) : null,
      suggestedBudgetKwh: suggestion.suggestedBudgetKwh,
      predictedKwh: suggestion.predictedKwh,
      predictedLowKwh: suggestion.predictedLowKwh,
      predictedHighKwh: suggestion.predictedHighKwh,
      forecastMeanTempC: suggestion.forecastMeanTempC,
      forecastSource: suggestion.forecastSource,
      computedAtMs: suggestion.computedAtMs,
      beyondObservedCold: suggestion.beyondObservedCold,
      beyondObservedWarm: suggestion.beyondObservedWarm,
      budgetMayBeLimiting: suggestion.budgetMayBeLimiting,
      sustainableDailyCeilingKwh: resolveDailyCeiling(suggestion.targetDateKey, deps),
      pressureThroughDateKey: state.budgetPressure?.throughDateKey ?? null,
      pressureAccumulatorKwh: state.budgetPressure?.kwh ?? 0,
      pressureContributionKwh: suggestion.budgetPressureKwh,
      modelPseudoR2: numberOrNull(state.latestFit?.pseudoR2),
      modelUsableDays: numberOrNull(state.latestFit?.usableDays),
    });
  } catch (error) {
    deps.logger.warn({ event: 'budget_advice_history_record_failed', err: normalizeError(error) });
  }
}

// The planning ceiling over the target local day; null when no power limit is
// enabled: nothing caps the day.
function resolveDailyCeiling(targetDateKey: string, deps: AutoApplyDeps): number | null {
  const ceiling = planningPowerCeiling(deps.getPowerLimitSettings());
  if (ceiling === null) return null;
  const timeZone = deps.getTimeZone();
  const startMs = getDateKeyStartMs(targetDateKey, timeZone);
  const hours = (getNextLocalDayStartUtcMs(startMs, timeZone) - startMs) / (60 * 60 * 1000);
  return ceiling.kw * hours;
}

function readAppliedBudget(deps: AutoApplyDeps): number | null {
  return deps.getAppliedDailyBudgetKwh?.() ?? null;
}

function numberOrNull(value: number | undefined): number | null {
  return value ?? null;
}
