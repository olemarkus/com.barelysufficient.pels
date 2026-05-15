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
  // Planner's effective useful power (kW) used to estimate hours-of-work for
  // the current plan. Surfaced in the hero meta line ("Y.Y kW") so the user
  // can sanity-check estimated duration. Optional for backward compatibility.
  planningSpeedKw?: number;
  // Pre-formatted estimated duration ("Yh Zm") matching `planningSpeedKw`.
  // Lives on the revision so all surfaces format consistently with the math
  // the planner actually used. Optional for backward compatibility.
  estimatedDurationText?: string;
};

export type DeferredObjectiveActivePlanPendingReason =
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing'
  // EV plugged-out / discharging — surfaced as a paused state in the UI.
  | 'invalid_session'
  // Thermal device with no learned `kWhPerUnit` profile yet — the planner has
  // no shipped bootstrap rate for thermal kinds, so it sits pending until
  // accepted samples produce a profile.
  | 'missing_capacity';

// Snapshot of the learned kWh-per-unit profile that produced the latest
// revision. Lets the UI render provenance (learned value, accepted samples,
// confidence, last accepted sample time) without the recorder fanning out to
// the live profile store. Optional for backward compatibility.
export type DeferredObjectiveKwhPerUnitProvenanceV1 = {
  // 'bootstrap' when no learned profile exists yet (EV only ships a bootstrap);
  // 'learned' once accepted samples produced a profile mean.
  source: DeferredObjectiveActivePlanKwhPerUnitSource;
  // Learned mean kWh per unit (°C or %). Null when no profile exists yet.
  kWhPerUnit: number | null;
  // Number of accepted samples that fed the learned profile. Zero when source
  // is 'bootstrap'.
  acceptedSamples: number;
  // Confidence band of the learned profile (`low` / `medium` / `high`). Null
  // when source is 'bootstrap'.
  confidence: 'low' | 'medium' | 'high' | null;
  // Last accepted sample timestamp; null when there is no profile yet.
  lastAcceptedAtMs: number | null;
};

export type DeferredObjectiveActivePlanV1 = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  startedAtMs: number;
  pending: boolean;
  // Per-plan provenance snapshot. Optional so older persisted plans without
  // the field continue to load; the UI should treat absence as "unknown" and
  // fall back to the live `objectiveProfiles` lookup.
  kwhPerUnitProvenance?: DeferredObjectiveKwhPerUnitProvenanceV1;
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
