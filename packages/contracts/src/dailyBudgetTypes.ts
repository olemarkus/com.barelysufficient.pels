export type DailyBudgetModelSettings = {
  enabled: boolean;
  dailyBudgetKWh: number;
  priceShapingEnabled: boolean;
  controlledUsageWeight: number;
  priceShapingFlexShare: number;
};

export type DailyBudgetDayPayload = {
  dateKey: string;
  timeZone: string;
  nowUtc: string;
  dayStartUtc: string;
  currentBucketIndex: number;
  budget: {
    enabled: boolean;
    dailyBudgetKWh: number;
    priceShapingEnabled: boolean;
  };
  state: {
    usedNowKWh: number;
    allowedNowKWh: number;
    remainingKWh: number;
    deviationKWh: number;
    exceeded: boolean;
    frozen: boolean;
    confidence: number;
    priceShapingActive: boolean;
    allocationPressure?: DailyBudgetAllocationPressure;
    confidenceDebug?: ConfidenceDebug;
    // Single producer-resolved end-of-day projection. The Budget chart, hero
    // strip, plan_budget widget, and the verdict all read THIS — never their own
    // re-derivation — so they can never disagree. Cost is in the price minor
    // unit (e.g. øre); consumers apply the shared CostDisplay divisor.
    projection?: DailyBudgetProjectionState;
    // Provenance of the active dailyBudgetKWh for the viewed day: 'weather' when
    // weather auto-apply set it for this day, else 'manual'. Gates the
    // weather-provenance caption without the chart branching on weather state.
    budgetSource?: DailyBudgetSource;
  };
  buckets: {
    startUtc: string[];
    startLocalLabels: string[];
    plannedWeight: number[];
    plannedKWh: number[];
    plannedUncontrolledKWh: number[];
    /** Gross background forecast used for physical-capacity reservation; budget math uses plannedUncontrolledKWh. */
    plannedGrossUncontrolledKWh?: number[];
    plannedControlledKWh: number[];
    actualKWh: number[];
    actualControlledKWh: Array<number | null>;
    actualUncontrolledKWh: Array<number | null>;
    allowedCumKWh: number[];
    // Stable day-start budget pace (dailyBudgetKWh × normalised profile
    // weights, cumulative) — the chart's single green reference. Ends at the
    // cap and does NOT re-pace as the user under/over-spends.
    budgetPaceCumKWh?: number[];
    // Where the day lands at the user's current relative pace (cumulative).
    projectionCumKWh?: number[];
    // Cumulative cost (price minor unit) for actuals-so-far / the budget pace /
    // the projection. null entries where unmeasured or un-priceable.
    actualCostCumMinor?: Array<number | null>;
    budgetPaceCostCumMinor?: Array<number | null>;
    projectionCostCumMinor?: Array<number | null>;
    price?: Array<number | null>;
    priceFactor?: Array<number | null>;
  };
};

export type DailyBudgetStatus = 'within' | 'tight' | 'over';

export type DailyBudgetSource = 'weather' | 'manual';

export type DailyBudgetProjectionState = {
  endOfDayKWh: number;
  endOfDayCostMinor: number | null;
  status: DailyBudgetStatus;
};

export type DailyBudgetAllocationPressure = {
  requestedBudgetKWh: number;
  plannedBudgetKWh: number;
  unallocatedBudgetKWh: number;
  saturationRatio: number;
  constrained: boolean;
  maxFittingDailyBudgetKWh: number;
};

export type ConfidenceDebug = {
  confidenceRegularity: number;
  confidenceAdaptability: number;
  confidenceAdaptabilityInfluence: number;
  confidenceWeightedControlledShare: number;
  confidenceValidActualDays: number;
  confidenceValidPlannedDays: number;
  confidenceBootstrapLow: number;
  confidenceBootstrapHigh: number;
  profileBlendConfidence: number;
};

export type DailyBudgetUiPayload = {
  days: Record<string, DailyBudgetDayPayload>;
  todayKey: string;
  tomorrowKey?: string | null;
  yesterdayKey?: string | null;
};

/**
 * What a daily-budget read answers.
 *
 * Absence is a NAMED member, not a nullable payload: `unavailable` is the
 * honest answer while the budget model has not produced a day snapshot yet —
 * the boot window before the first compute, a compute that failed and left
 * nothing behind, and (at the settings/widget seams) the restart window in
 * which `homey.app` is not wired at all. It is never a home that has a budget
 * of zero, and the `budget` arm always carries a real snapshot.
 */
export type DailyBudgetUiRead =
  | { kind: 'budget'; payload: DailyBudgetUiPayload }
  | { kind: 'unavailable' };

export type DailyBudgetModelPreviewResponse = {
  /** The budget in force before the preview — `unavailable` in the boot window. */
  active: DailyBudgetUiRead;
  /** Always computed: the preview runs the model against the submitted settings. */
  candidate: DailyBudgetUiPayload;
  settings: DailyBudgetModelSettings;
};
