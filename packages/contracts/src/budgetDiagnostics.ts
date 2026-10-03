import type { WeatherDailyRecord, BudgetPressureState } from './weatherAdvisorTypes.js';

/** Recorded advice, rather than a retrospective prediction from today's fit. */
export type BudgetAdviceDecision = {
  /** Absent on advice recorded before the recovery-aware algorithm. */
  budgetAlgorithmVersion?: 2;
  recordedAtMs: number;
  targetDateKey: string;
  meterScopeSignature: string | null;
  outcome: 'applied' | 'auto_apply_off' | 'would_lower_while_limiting' | 'budget_disabled_or_unavailable';
  budgetBeforeKwh: number | null;
  /** Read back from the budget owner after a successful apply; unknown stays null. */
  budgetAfterKwh: number | null;
  suggestedBudgetKwh: number;
  predictedKwh: number;
  predictedLowKwh: number;
  predictedHighKwh: number;
  forecastMeanTempC: number;
  forecastSource: 'met_api' | 'recent_days';
  computedAtMs: number;
  beyondObservedCold: boolean;
  beyondObservedWarm: boolean;
  budgetMayBeLimiting: boolean;
  sustainableDailyCeilingKwh: number | null;
  pressureThroughDateKey: string | null;
  pressureAccumulatorKwh: number;
  pressureContributionKwh: number;
  modelPseudoR2: number | null;
  modelUsableDays: number | null;
};

export type BudgetHistoryRange = { from: string; to: string };

export type BudgetHistoryMetadata = {
  schemaVersion: 1;
  generatedAtMs: number;
  timeZone: string;
  /** Weather/budget learning belongs to this whole-home meter scope, not a selectable sub-home. */
  meterScopeSignature: string | null;
  requested: BudgetHistoryRange;
  retained: BudgetHistoryRange | null;
  /** No record exists for these requested local dates; they are not zero-usage days. */
  missingDates: string[];
};

export type BudgetDailyHistory = {
  meta: BudgetHistoryMetadata;
  records: WeatherDailyRecord[];
  /** Current state only. Historical pressure is available on recorded advice decisions. */
  currentBudgetPressure: BudgetPressureState | null;
};

export type BudgetDecisionHistory = {
  meta: BudgetHistoryMetadata;
  records: BudgetAdviceDecision[];
};
