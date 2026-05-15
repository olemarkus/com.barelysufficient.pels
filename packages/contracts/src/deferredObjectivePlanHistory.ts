import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanStatusV1,
} from './deferredObjectiveActivePlans.js';

export type DeferredObjectivePlanOutcome =
  | 'met'
  | 'missed'
  | 'abandoned'
  | 'replaced'
  | 'unknown';

export type DeferredObjectivePlanHistoryDiscoveredFrom = 'observation' | 'backfill';

export type DeferredObjectivePlanHistoryObservedInterval = {
  fromMs: number;
  toMs: number;
};

// Snapshot of a plan revision persisted with a history entry so the detail
// page can reconstruct the hourly chart after the run has finalized. Mirrors
// the runtime `DeferredObjectiveActivePlanRevisionV1` minus fields that don't
// matter retrospectively (`revision` index, `reason`, `kwhPerUnitSource`).
export type DeferredObjectivePlanHistoryRevisionSnapshot = {
  hours: DeferredObjectiveActivePlanHourV1[];
  energyNeededKWh: number;
  planStatus: DeferredObjectiveActivePlanStatusV1;
  revisedAtMs: number;
};

export type DeferredObjectivePlanHistoryEntry = {
  // Opaque stable identifier (uuid) assigned at finalization. Used as the URL
  // key for the history detail route so callers never depend on timestamp
  // uniqueness across replays / migrations / future synthetic sources.
  id: string;
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  startedAtMs: number;
  finalizedAtMs: number;
  startProgressC: number | null;
  startProgressPercent: number | null;
  finalProgressC: number | null;
  finalProgressPercent: number | null;
  initialEnergyNeededKWh: number;
  outcome: DeferredObjectivePlanOutcome;
  metAtMs: number | null;
  usedDeadlineReserve: boolean;
  usedPolicyAvoid: boolean;
  observedIntervals: DeferredObjectivePlanHistoryObservedInterval[];
  discoveredFrom: DeferredObjectivePlanHistoryDiscoveredFrom;
  // First revision recorded for this run. `null` when no plan was ever
  // recorded (backfill entries, legacy v2 entries upgraded without source
  // plans, or runs that finalized before the planner produced a revision).
  originalPlan: DeferredObjectivePlanHistoryRevisionSnapshot | null;
  // Last `latest` revision at finalization. `null` under the same conditions
  // as `originalPlan`. When `originalPlan === finalPlan` shape-wise, the run
  // never replanned.
  finalPlan: DeferredObjectivePlanHistoryRevisionSnapshot | null;
  // Total number of revisions the active-plan recorder wrote for this run
  // (i.e. `plan.latest.revision` at finalization). `1` means the planner never
  // replanned; higher values indicate one or more `prices_revised`,
  // `rate_refined`, or `objective_changed` revisions on top of the original.
  // Optional so v3 entries persisted before this field was added continue to
  // load — the history detail treats absence as "unknown" and falls back to
  // a generic copy.
  revisionCount?: number;
};

export type DeferredObjectivePlanHistoryV3 = {
  version: 3;
  entries: DeferredObjectivePlanHistoryEntry[];
};

// Legacy v2 entry shape kept only so the v2→v3 migration can read pre-v3
// data. The v2 envelope (`{ version: 2, entries: ... }`) isn't exported as a
// type because no production code constructs it.
export type DeferredObjectivePlanHistoryEntryV2 = Omit<
  DeferredObjectivePlanHistoryEntry,
  'id' | 'originalPlan' | 'finalPlan'
>;

// Legacy v1 entry shape kept only so the migration in planHistorySettings.ts can read pre-v2
// data.
export type DeferredObjectivePlanHistoryEntryV1 = Omit<
  DeferredObjectivePlanHistoryEntryV2,
  'observedIntervals' | 'discoveredFrom'
>;
