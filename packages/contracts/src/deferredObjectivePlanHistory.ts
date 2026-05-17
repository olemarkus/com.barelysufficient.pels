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
  // Effective kWh-per-unit the planner used when this revision was written.
  // Captures `kwhPerUnitProvenance.kWhPerUnit` from the active plan at
  // snapshot time so the history detail page can render the planned
  // trajectory (`hours × kwhPerUnitMean` integrated from the start progress)
  // without re-deriving from the live profile store. Optional: legacy v3
  // entries (and revisions where the planner never resolved a profile)
  // persist without the field — UI consumers must treat absence as
  // "fall back to a straight line through hours". Added in schema v4.
  kwhPerUnitMean?: number;
};

// Hourly snapshot of objective progress while a run is in flight. The
// recorder maintains a per-run ring keyed by hour-aligned `atMs` and drains
// it into the entry at finalization. Each sample carries whichever progress
// value applies to the objective kind (temperature → `valueC`, EV SoC →
// `valuePercent`); the other field is always `null` so the consumer never
// has to branch on `objectiveKind` to pick the field. Added in schema v4.
export type DeferredObjectivePlanHistoryProgressSample = {
  atMs: number;
  valueC: number | null;
  valuePercent: number | null;
};

// Recorded per-revision metadata so the history detail page can render a
// chronological revision log. `reasonId` mirrors
// `DeferredObjectiveActivePlanRevisionReason` (`flow_card`, `prices_revised`,
// `rate_refined`, `objective_changed`, `prices_arrived`, `device_unavailable`,
// `measured_deviation`); kept as a plain string so the contract stays
// browser-safe (the union is owned by `deferredObjectiveActivePlans.ts`).
// `hoursAdded` / `hoursRemoved` are the symmetric-difference counts of
// `startsAtMs` between consecutive revisions, suitable for an inline
// `+a / −b` mini-diff. Added in schema v4.
export type DeferredObjectivePlanHistoryRevisionLogEntry = {
  atMs: number;
  reasonId: string;
  hoursAdded: number;
  hoursRemoved: number;
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
  // Hourly downsample of progress observations across the run, drained from
  // the recorder's in-memory ring at finalization. Capped at
  // `PROGRESS_SAMPLES_PER_ENTRY_CAP` (48) so the entry stays bounded in JSON
  // size regardless of how long the run was; the cap matches a 2-day window
  // at hourly granularity which is wider than any deadline we expect to
  // ship. Optional — legacy v3 entries (and runs that finalized before this
  // field shipped) read with the field absent and the UI falls back to a
  // headline-only summary. Added in schema v4.
  progressSamples?: DeferredObjectivePlanHistoryProgressSample[];
  // Total useful energy delivered to the device across the run, summed from
  // the runtime hourly delivery feed. Optional — a run that finalizes
  // without ever receiving an hourly delivery contribution (e.g. price
  // service unavailable, hourly meter feed not wired yet) persists without
  // the field; UI consumers must treat absence as "unknown" rather than 0.
  // Added in schema v4.
  deliveredKWh?: number;
  // Σ priceValue × deliveredKWh across the run, in the user's display
  // currency. Same optionality rationale as `deliveredKWh`. Added in
  // schema v4.
  totalCost?: number;
  // Chronological list of revisions written by the active-plan recorder for
  // this run, one entry per increment of `plan.latest.revision`. The first
  // revision (`revision === 1`) is not recorded here — its metadata lives on
  // `originalPlan` — so an unrevised run persists with the field absent or
  // empty. Optional for backward compatibility with v3 entries. Added in
  // schema v4.
  revisions?: DeferredObjectivePlanHistoryRevisionLogEntry[];
};

// Runtime cap on `progressSamples` per entry lives in
// `lib/plan/deferredObjectives/planHistory.ts` as a local constant — runtime
// code must not value-import contract source files (see
// `test/runtimePackaging.test.ts`). The Settings UI (PRs 2–7 of the v2.7.2
// train) will surface its own constant or read the array length directly,
// so we deliberately don't export the cap here until a consumer needs it.

export type DeferredObjectivePlanHistoryV4 = {
  version: 4;
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
