export type DailyBudgetAggressiveness = 'relaxed' | 'balanced' | 'strict';

export type DailyBudgetSettings = {
  enabled: boolean;
  dailyBudgetKWh: number;
  aggressiveness: DailyBudgetAggressiveness;
  priceShapingEnabled: boolean;
};

export type DailyBudgetProfile = {
  weights: number[];
  sampleCount: number;
};

export type DailyBudgetState = {
  dateKey?: string | null;
  dayStartUtcMs?: number | null;
  plannedKWh?: number[];
  frozen?: boolean;
  lastPlanBucketStartUtcMs?: number | null;
  lastPlanUpdateMs?: number | null;
  pressure?: number;
  lastPressureUpdateMs?: number | null;
  profile?: DailyBudgetProfile;
};

export type DailyBudgetUiPayload = {
  dateKey: string;
  timeZone: string;
  nowUtc: string;
  dayStartUtc: string;
  currentBucketIndex: number;
  budget: {
    enabled: boolean;
    dailyBudgetKWh: number;
    aggressiveness: DailyBudgetAggressiveness;
    priceShapingEnabled: boolean;
  };
  state: {
    usedNowKWh: number;
    allowedNowKWh: number;
    remainingKWh: number;
    pressure: number;
    exceeded: boolean;
    frozen: boolean;
    confidence: number;
    priceShapingActive: boolean;
  };
  buckets: {
    startUtc: string[];
    startLocalLabels: string[];
    plannedWeight: number[];
    plannedKWh: number[];
    actualKWh: number[];
    allowedCumKWh: number[];
    price?: Array<number | null>;
    priceFactor?: Array<number | null>;
  };
};

export type DailyBudgetUpdate = {
  snapshot: DailyBudgetUiPayload;
  shouldPersist: boolean;
};
