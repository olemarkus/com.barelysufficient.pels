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

// Why a 'met' run was marked done. Absent on the default "reached target"
// path so legacy entries (and the overwhelming majority of clean met runs)
// persist byte-stable.
//
// `'stalled'` is the idle-classifier `near_target_idle` promotion: the
// device stopped drawing close to its setpoint, so PELS declared the
// objective satisfied without the progress series literally crossing the
// target threshold. See `notes/idle-classification.md` for the 5 °C / 15
// min thresholds and the Connected 300 worked example. Added in v2.7.3.
//
// `'stalled_device_capped'` is the idle-classifier `capped_idle`
// promotion: the device parked at a stable plateau several degrees below
// the PELS-commanded target while its power cycled around its own internal
// thermostat cap (e.g. a Connected 300 capped internally at ~60 °C with a
// 65 °C smart-task target). The recorder accepts this as `met` so the run
// doesn't read as a false miss, but the distinct reason lets the
// postmortem name the device's own setpoint cap as the cause — not the
// PELS-canonical hard cap (per `feedback_hard_cap_is_physical.md`).
// Added in v2.9.x.
//
// Both variants are optional and consumers must treat absence as the
// legacy "reached the configured target" shape. The validator accepts
// either string on `met` outcomes; any other shape (an unknown string,
// the field present on a non-met outcome) is treated as schema tamper and
// dropped on read.
export type DeferredObjectivePlanMetReason = 'stalled' | 'stalled_device_capped';

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
  // Number of horizon buckets whose per-bucket cap collapsed to zero because
  // the daily budget cap had already been reached when this revision was
  // written. Mirrors the runtime
  // `DeferredObjectiveActivePlanRevisionV1.dailyBudgetExhaustedBucketCount`
  // so the history-detail postmortem can explain a `cannot_meet` outcome
  // that would otherwise read as a device or schedule problem. Optional:
  // legacy v3 entries and revisions written before this field shipped
  // persist without it — consumers treat absence as zero. Added in v2.7.2.
  dailyBudgetExhaustedBucketCount?: number;
  // Plan-time provenance of the learned kWh-per-unit rate that backed this
  // revision, pulled from the active plan's `kwhPerUnitProvenance` at snapshot
  // time. Persisted so a finalized `missed` entry can be attributed to a
  // shaky estimate (low confidence / few samples) versus a genuine capacity
  // shortfall — the live profile store has long since moved on by the time
  // anyone reads the history. Both optional: absent for bootstrap plans, for
  // revisions written before a profile resolved, and for legacy entries
  // persisted before this field shipped (consumers treat absence as
  // "unknown" and suppress the confidence half of the attribution). Added in
  // v2.7.4.
  rateConfidence?: 'low' | 'medium' | 'high';
  acceptedSamples?: number;
  // The per-active-hour useful power (kW) the planner committed for this run —
  // the lowest non-zero step, the only delivery guaranteed for a full hour
  // (see `lib/objectives/deferredObjectives/planningSpeed.ts`). Mirrors the active
  // plan's `initialPlanningSpeedKw`. Persisted so the attribution can compare
  // the committed floor against the energy the executor actually delivered:
  // delivery at or above the floor on a missed run points at an energy-needed
  // underestimate rather than a capacity miss. Optional — absent when the
  // plan never resolved a planning speed and on legacy entries. Added in
  // v2.7.4.
  planningSpeedKw?: number;
  // Mean-based plan total (no variance buffer), pulled from the active plan's
  // most recent revision at finalize time. Persisted so the UI render path can
  // resolve the same `missCause` the runtime log emits — without this field the
  // shared attribution helper would fall back to comparing delivered energy
  // against the buffered `plannedKWh` sum (mean + k·SE) and mislabel a
  // cold-start run as `capacity_shortfall` when delivery actually met the
  // underlying mean. Optional — absent on entries persisted before this field
  // shipped, on the backfill `discoveredFrom: 'backfill'` path (synthesized from
  // settings without a live plan), and on observation-derived runs whose plan
  // never resolved `energyExpectedKWh` (steady devices where the planner omits
  // the field once it equals the buffered total). Consumers must treat absence
  // as "fall back to the buffered comparison" — same behaviour as before this
  // field shipped, so legacy entries render no-worse-than-before. Producer
  // writes a finite positive number when present.
  energyExpectedKWh?: number;
};

// Price-tier classification for a single hour's delivery contribution. The
// recorder writes the tone alongside the kWh / price so the postmortem
// surface ("when did each hour run, and what did each hour cost?") never
// re-derives a band from the persisted price (which would need historical
// thresholds that may have shifted across versions). The three tiers match
// the cheap / normal / expensive heatmap split surfaced elsewhere in the UI.
export type DeferredObjectivePlanHistoryHourlyTone = 'cheap' | 'normal' | 'expensive';

// Per-hour delivery contribution persisted alongside `deliveredKWh` /
// `totalCost`. Each entry corresponds to one `recordHourlyDelivery` call,
// captured at hour-aligned `atMs` with the delivered kWh, the spot price
// the recorder summed into `totalCost`, and the resolved price tone. The
// postmortem bar strip on `DeadlinePlanHistoryDetail` reads this list to
// render one bar per hour. Optional — runs that finalize without any
// hourly delivery contribution (price feed unavailable, legacy v4 entries
// from before this field shipped) persist without it and the bar strip is
// suppressed. Added in schema v4 as an additive optional field (no version
// bump: v4 already shipped in v2.7.2, but older clients preserve unknown
// fields on round-trip and absence degrades gracefully).
export type DeferredObjectivePlanHistoryHourlyContribution = {
  atMs: number;
  deliveredKWh: number;
  priceValue: number;
  tone: DeferredObjectivePlanHistoryHourlyTone;
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

// Price-display provenance captured at record time so the archive can format
// the persisted `totalCost` in the currency it was accumulated in — NOT the
// currency that happens to be bootstrapped when the user later opens the
// archive. `totalCost` is a sum of `priceValue × deliveredKWh` in the price
// scheme's raw minor unit (øre for the default Norwegian Nordpool scheme), so
// the archive must scale it by THIS entry's `divisor` (÷100 → kr) and label it
// with THIS entry's `unit`. Without it a Norway run recorded as 150 øre would
// render "≈ 150 EUR" after the user switches to a Flow/Homey scheme (divisor 1,
// different unit) instead of the correct "≈ 2 kr". Mirrors the settings-UI
// `CostDisplay { unit, divisor }` shape (`dailyBudgetCost.ts`) but is declared
// here so the contract stays browser-safe and runtime-importable.
//
// Optional for back-compat: legacy entries persisted before this field shipped
// (and entries that finalized without any hourly delivery contribution) load
// with it absent. Consumers MUST fall back to the recording-era default
// øre/kr scheme (`{ unit: 'kr', divisor: 100 }`) — every entry that predates
// this field was recorded under that scheme, so labelling absence as øre/kr is
// the correct historical assumption (see
// `DEFAULT_HISTORY_COST_DISPLAY` in `deferredPlanHistoryReceipt.ts`).
export type DeferredObjectivePlanHistoryCostDisplay = {
  unit: string;
  divisor: number;
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
  // When `outcome === 'met'` and absent, the run is interpreted as having
  // literally crossed the target (the existing semantics). `'stalled'` flags
  // the idle-classifier promotion path — see `DeferredObjectivePlanMetReason`.
  // Always absent for non-`met` outcomes; producers must not write it on
  // missed/abandoned/replaced/unknown entries.
  metReason?: DeferredObjectivePlanMetReason;
  metAtMs: number | null;
  usedDeadlineReserve: boolean;
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
  // Σ priceValue × deliveredKWh across the run, in the price scheme's raw
  // minor unit at record time (øre for the default Norwegian scheme). Scale
  // and label it with `costDisplay` (below), NOT a live display, or it renders
  // in the wrong currency after a scheme switch. Same optionality rationale as
  // `deliveredKWh`. Added in schema v4.
  totalCost?: number;
  // Price-display provenance (`{ unit, divisor }`) the `totalCost` above was
  // accumulated under. Persisted at finalize time alongside `totalCost` so the
  // archive formats the figure in its recorded currency rather than the
  // currently-bootstrapped one. Optional: absent on legacy entries (and entries
  // with no `totalCost`); consumers fall back to the recording-era øre/kr
  // default. See `DeferredObjectivePlanHistoryCostDisplay`. Added in schema v4
  // as an additive optional field (no version bump: v4 already shipped in
  // v2.7.2, but the normalizer keeps unknown/absent fields whole on round-trip,
  // so extending it in place is safe for both older and newer clients).
  costDisplay?: DeferredObjectivePlanHistoryCostDisplay;
  // Chronological list of revisions written by the active-plan recorder for
  // this run, one entry per increment of `plan.latest.revision`. The first
  // revision (`revision === 1`) is not recorded here — its metadata lives on
  // `originalPlan` — so an unrevised run persists with the field absent or
  // empty. Optional for backward compatibility with v3 entries. Added in
  // schema v4.
  revisions?: DeferredObjectivePlanHistoryRevisionLogEntry[];
  // Per-hour delivery contributions captured by the recorder, one entry per
  // hour the runtime fed a `recordHourlyDelivery` contribution. Optional —
  // legacy v4 entries (from before this field shipped) and runs that never
  // received a contribution persist without it; the postmortem suppresses
  // the bar strip in that case. Added in schema v4 as an additive optional
  // field (no migration: existing v4 entries simply load with the field absent
  // and degrade gracefully). See `DeferredObjectivePlanHistoryHourlyContribution`.
  hourlyContributions?: DeferredObjectivePlanHistoryHourlyContribution[];
};

// Runtime cap on `progressSamples` per entry lives in
// `lib/objectives/deferredObjectives/planHistory.ts` as a local constant — runtime
// code must not value-import contract source files (see
// `test/runtimePackaging.test.ts`). The Settings UI (PRs 2–7 of the v2.7.2
// train) will surface its own constant or read the array length directly,
// so we deliberately don't export the cap here until a consumer needs it.

// Hourly progress sample with the kind-split (°C/%) pair already resolved to a
// single unit-agnostic number. This is the shape consumers receive — the raw
// `valueC`/`valuePercent` pair never crosses the API/producer boundary.
export type ResolvedDeferredObjectivePlanHistoryProgressSample = {
  atMs: number;
  value: number | null;
};

// Consumer-facing view of a finalized plan-history entry. The raw kind-split
// value columns (`targetTemperatureC`/`targetPercent`, `startProgress*`,
// `finalProgress*`, and sample `valueC`/`valuePercent`) are RESOLVED to single
// unit-agnostic numbers (`targetValue` / `startProgressValue` /
// `finalProgressValue`, sample `value`) by `toResolvedPlanHistoryEntry` before
// the entry reaches any consumer. The raw columns are intentionally ABSENT from
// this type, so reading one is a compile error: consumers branch on
// `objectiveKind` only to pick a display unit, never to pick a value.
// Persistence keeps the raw columns (see `DeferredObjectivePlanHistoryEntry`);
// resolution happens once, at the producer boundary.
export type ResolvedDeferredObjectivePlanHistoryEntry = Omit<
  DeferredObjectivePlanHistoryEntry,
  'targetTemperatureC' | 'targetPercent'
  | 'startProgressC' | 'startProgressPercent'
  | 'finalProgressC' | 'finalProgressPercent'
  | 'progressSamples'
> & {
  targetValue: number | null;
  startProgressValue: number | null;
  finalProgressValue: number | null;
  progressSamples?: ResolvedDeferredObjectivePlanHistoryProgressSample[];
};

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
