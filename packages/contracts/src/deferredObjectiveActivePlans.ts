// Type-only file: runtime code must not value-import contracts per the
// packaging boundary. The schema version literal lives at the runtime side
// (`lib/plan/deferredObjectives/activePlanSettings.ts`).

export type DeferredObjectiveActivePlanRevisionReason =
  | 'flow_card'
  | 'prices_arrived'
  | 'objective_changed'
  | 'prices_revised'
  | 'rate_refined'
  | 'device_unavailable'
  | 'measured_deviation';

// Identifies whether the kWh-per-unit value used for the revision came from a
// learned profile or the bootstrap fallback. Optional so older persisted
// plans (without the field) continue to load.
export type DeferredObjectiveActivePlanKwhPerUnitSource = 'learned' | 'bootstrap';

export type DeferredObjectiveActivePlanHourV1 = {
  startsAtMs: number;
  plannedKWh: number;
};

// Mirrors `DeferredObjectiveHorizonStatus` in `lib/plan/deferredObjectives/types`.
// Duplicated here because contracts must stay browser-safe and cannot import
// from `lib/`.
export type DeferredObjectiveActivePlanStatusV1 =
  | 'at_risk'
  | 'cannot_meet'
  | 'invalid'
  | 'on_track'
  | 'satisfied';

export type DeferredObjectiveActivePlanRevisionV1 = {
  revision: number;
  revisedAtMs: number;
  computedFromPricesUpTo: number | null;
  reason: DeferredObjectiveActivePlanRevisionReason;
  hours: DeferredObjectiveActivePlanHourV1[];
  // Total energy the planner thinks is required to meet the deadline. Lets the
  // UI render a meaningful timeline even when allocated hours sum to zero
  // (e.g. `cannot_meet` against a sub-second remaining bucket) and without
  // depending on a learned `kwhPerUnit` profile.
  energyNeededKWh: number;
  // Planner status. UI surfaces a "Can't fully meet" chip when this is
  // `cannot_meet` or `at_risk`.
  planStatus: DeferredObjectiveActivePlanStatusV1;
  // Source of the kWh-per-unit value the planner used. `bootstrap` means a
  // conservative default was used because no learned profile was available
  // yet; the next accepted sample will flip this to `learned`. Optional for
  // backward compatibility — older persisted revisions don't carry it and the
  // UI should treat absence as `learned`.
  kwhPerUnitSource?: DeferredObjectiveActivePlanKwhPerUnitSource;
  // Number of horizon buckets whose per-bucket cap collapsed to zero because
  // the daily budget cap had already been reached. Lets the UI explain a
  // `cannot_meet` outcome that would otherwise look like a device or schedule
  // problem. Optional for backward compatibility — older persisted revisions
  // don't carry it and the UI should treat absence as zero.
  dailyBudgetExhaustedBucketCount?: number;
};

export type DeferredObjectiveActivePlanPendingReason =
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing';

export type DeferredObjectiveActivePlanV1 = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  startedAtMs: number;
  pending: boolean;
  // Only meaningful when `pending` is true. Identifies why the recorder
  // couldn't produce a revision (e.g. price-aware optimisation off vs prices
  // not yet covering the horizon). Optional so older persisted plans without
  // this field continue to load.
  pendingReason?: DeferredObjectiveActivePlanPendingReason;
  // The signature of the objective settings that produced `latest`. Used to
  // detect `objective_changed` replans without re-deriving the hash on every
  // load.
  objectiveSignature: string;
  original: DeferredObjectiveActivePlanRevisionV1 | null;
  latest: DeferredObjectiveActivePlanRevisionV1 | null;
};

export type DeferredObjectiveActivePlansV1 = {
  version: 1;
  plansByDeviceId: Record<string, DeferredObjectiveActivePlanV1>;
};
