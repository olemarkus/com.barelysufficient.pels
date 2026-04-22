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
    confidenceDebug?: ConfidenceDebug;
  };
  explainability?: DailyBudgetExplainability;
  buckets: {
    startUtc: string[];
    startLocalLabels: string[];
    plannedWeight: number[];
    plannedKWh: number[];
    plannedUncontrolledKWh?: number[];
    plannedControlledKWh?: number[];
    actualKWh: number[];
    actualControlledKWh?: Array<number | null>;
    actualUncontrolledKWh?: Array<number | null>;
    allowedCumKWh: number[];
    price?: Array<number | null>;
    priceFactor?: Array<number | null>;
  };
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

export type DailyBudgetExplainability = {
  headline?: string;
  summary?: string;
  currentLimiterLabel?: string;
  currentLimiterDetail?: string;
  effectiveSoftLimitKw?: number | null;
  hourlySoftLimitKw?: number | null;
  dailySoftLimitKw?: number | null;
  hardCapKw?: number | null;
  budgetExemptKWh?: number | null;
  baseLoadKWh?: number | null;
  flexibleLoadKWh?: number | null;
  priceEffectLabel?: string;
  priceEffectDetail?: string;
  notes?: string[];
};

export type DailyBudgetUiPayload = {
  days: Record<string, DailyBudgetDayPayload>;
  todayKey: string;
  tomorrowKey?: string | null;
  yesterdayKey?: string | null;
};
