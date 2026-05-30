export type DailyBudgetSettings = {
  enabled: boolean;
  dailyBudgetKWh: number;
  priceShapingEnabled: boolean;
  controlledUsageWeight: number;
  priceShapingFlexShare: number;
};

export type DailyBudgetSettingsInput = Partial<DailyBudgetSettings>;

export type DailyBudgetProfile = {
  weights: number[];
  sampleCount: number;
};

export type DailyBudgetState = {
  dateKey?: string | null;
  dayStartUtcMs?: number | null;
  plannedKWh?: number[];
  plannedUncontrolledKWh?: number[];
  plannedControlledKWh?: number[];
  frozen?: boolean;
  lastPlanBucketStartUtcMs?: number | null;
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
  profileObservedP50UncontrolledKWh?: number[];
  profileObservedP75UncontrolledKWh?: number[];
  profileObservedP90UncontrolledKWh?: number[];
  profileObservedUncontrolledSampleCounts?: number[];
  profileObservedStatsConfigKey?: string;
};

// The daily-budget UI payload contract is owned by packages/contracts (the
// runtime→settings-UI seam already imports it from there). Re-export it here
// from that single source of truth instead of re-declaring it, so the runtime
// consumers and the smart-task controller resolve the same declaration the UI
// does, with no `objectives → dailyBudget` peer edge (PR-A2). Imported for
// local use by the response/update types below.
import type {
  ConfidenceDebug,
  DailyBudgetAllocationPressure,
  DailyBudgetDayPayload,
  DailyBudgetUiPayload,
} from '../../packages/contracts/src/dailyBudgetTypes';

export type {
  ConfidenceDebug,
  DailyBudgetAllocationPressure,
  DailyBudgetDayPayload,
  DailyBudgetUiPayload,
};

export type DailyBudgetModelPreviewResponse = {
  active: DailyBudgetUiPayload | null;
  candidate: DailyBudgetUiPayload | null;
  settings: DailyBudgetSettings;
};

export type DailyBudgetStatePersistReason =
  | 'runtime'
  | 'plan'
  | 'bucket'
  | 'frozen'
  | 'rollover'
  | 'observed_stats'
  | 'reset'
  | 'manual';

export type DailyBudgetUpdateStateOptions = {
  nowMs?: number;
  forcePlanRebuild?: boolean;
  persistReason?: DailyBudgetStatePersistReason;
};

export type DailyBudgetUpdate = {
  snapshot: DailyBudgetDayPayload;
  persistReason: DailyBudgetStatePersistReason | null;
};
