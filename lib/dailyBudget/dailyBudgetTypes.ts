export type DailyBudgetSettings = {
  enabled: boolean;
  dailyBudgetKWh: number;
  priceShapingEnabled: boolean;
  controlledUsageWeight: number;
  priceShapingFlexShare: number;
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
  lastUsedNowKWh?: number;
  profile?: DailyBudgetProfile;
  profileUncontrolled?: DailyBudgetProfile;
  profileControlled?: DailyBudgetProfile;
  profileControlledShare?: number;
  profileSampleCount?: number;
  profileSplitSampleCount?: number;
  profileObservedMaxUncontrolledKWh?: number[];
  profileObservedMaxControlledKWh?: number[];
  profileObservedMinUncontrolledKWh?: number[];
  profileObservedMinControlledKWh?: number[];
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
  };
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

export type DailyBudgetUiPayload = {
  days: Record<string, DailyBudgetDayPayload>;
  todayKey: string;
  tomorrowKey?: string | null;
  yesterdayKey?: string | null;
};

export type DailyBudgetUpdate = {
  snapshot: DailyBudgetDayPayload;
  shouldPersist: boolean;
};
