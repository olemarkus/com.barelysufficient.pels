// Type-only file: runtime code must not value-import contracts per the
// packaging boundary. The schema version literal lives at the runtime side
// (`lib/objectives/deferredObjectives/activePlanSettings.ts`).

// `prices_revised` is reserved for revisions where the planner consumed a
// newer price horizon than the last revision (Nordpool publishes tomorrow's
// prices 1–2 times per day; this label promises that event). When the
// schedule shifts for any other reason — daily-budget pressure flipping a
// bucket, device-state change, planStatus oscillating — the recorder emits
// `schedule_revised` instead. The split landed v2.7.3 to stop the revision
// log mis-labelling internal replans as "Tomorrow's prices published."
export type DeferredObjectiveActivePlanRevisionReason =
  | 'flow_card'
  | 'prices_arrived'
  | 'objective_changed'
  | 'prices_revised'
  | 'schedule_revised'
  | 'rate_refined'
  | 'device_unavailable'
  | 'measured_deviation'
  // `flow_permission_changed` is reserved for revisions caused by a Flow card toggling
  // a smart task's rescue permission. Like `device_unavailable` / `measured_deviation`,
  // it is forward-declared: the label + persistence allowlist are ready, but the
  // recorder does not emit it yet (rescue-change detection lands in a follow-up; today
  // a rescue toggle surfaces as `schedule_revised`). Distinct from `objective_changed`.
  | 'flow_permission_changed';

// Identifies whether the kWh-per-unit value used for the revision came from a
// learned profile or the bootstrap fallback. Optional so older persisted
// plans (without the field) continue to load.
export type DeferredObjectiveActivePlanKwhPerUnitSource = 'learned' | 'bootstrap';

// Producer-resolved presentation-speed mode for the hero meta line. The
// recorder collapses `kwhPerUnitSource` into this flat enum so the settings UI
// never branches on planner internals (`feedback_layering_resolution_in_producer`):
//   `learning` — the revision used the bootstrap kWh/% fallback (no learned
//                profile yet; EV cold-start only).
//   `auto`     — a learned profile drove the rate (the steady state).
// The human label strings ("Auto" / "Learning…") stay in the settings UI per
// `feedback_ui_text_shared_with_logs` — only the enum is persisted. `Manual`
// / `Conservative` are future modes that would extend this union if/when they
// ship. Optional for backward compatibility — older persisted revisions don't
// carry it and the UI falls back to deriving it from `kwhPerUnitSource`
// (absent → `auto`).
export type DeferredObjectiveActivePlanSpeedMode = 'auto' | 'learning';

// Producer-resolved verdict for what bound the floor schedule on this revision.
// Mirrors the planner's `statusDetail` mapping in
// `lib/objectives/deferredObjectives/floorShortfallCause.ts` (`limited_by_daily_budget`
// → `budget`, `feasible_above_floor` → `step_power`, `estimate_uncertain` →
// `estimate`, `target_cannot_be_met` → `time_capacity`, anything else → `none`).
// Persisted so the hero copy resolver can route a `cannot_meet` / `at_risk` plan
// to the budget-bound recourse (`Open Budget`) without re-deriving cause from
// `dailyBudgetExhaustedBucketCount` — which fails on the per-bucket background
// squeeze case where the count stays at zero but the cause is still budget.
// Optional so older persisted plans (without the field) continue to load and
// the UI should fall back to the legacy `(cannot_meet || at_risk) &&
// bucketCount > 0` derivation when absent.
export type DeferredObjectiveActivePlanFloorShortfallCause =
  | 'budget'
  | 'step_power'
  | 'estimate'
  | 'time_capacity'
  | 'none';

// Hourly snapshot of objective progress while a run is in flight. Structurally
// identical to `DeferredObjectivePlanHistoryProgressSample` in
// `deferredObjectivePlanHistory.ts`, but duplicated here on purpose:
// `deferredObjectivePlanHistory.ts` already imports from THIS file
// (`DeferredObjectiveActivePlanHourV1` / `…StatusV1`), so importing the history
// sample type back here would close a circular dependency (rejected by the
// `no-circular` dep-cruiser rule). The shapes are byte-identical so values flow
// between the two structurally. Added 2026-06-02 for the smart-tasks widget
// trajectory chart.
export type DeferredObjectiveActivePlanProgressSampleV1 = {
  atMs: number;
  valueC: number | null;
  valuePercent: number | null;
};

export type DeferredObjectiveActivePlanHourV1 = {
  startsAtMs: number;
  plannedKWh: number;
  // Actual coverage start of this hour's booked energy, when it is a sub-hour
  // span `[coversFromMs, hourEnd]` rather than the full hour. Set only for the
  // current hour at a mid-hour revision: the horizon planner trims that
  // bucket's start to `nowMs` (see `buildHoursFromHorizonPlan`), so its
  // `plannedKWh` is already only the post-revision remainder. Absent ⇒ the
  // energy covers the full hour `[startsAtMs, startsAtMs+1h]` (a freshly-booked
  // full hour or a full-hour commitment floor). Consumed by the history-detail
  // chart to decide whether the revised-trajectory riser is prorated
  // (full-hour floor) or added whole (already-trimmed). Optional/back-compatible:
  // legacy entries persisted without it read as full-hour. Added 2026-06-01.
  coversFromMs?: number;
};

export type DeferredObjectiveActivePlanCommitmentV1 = {
  committedAtMs: number;
  hours: DeferredObjectiveActivePlanHourV1[];
};

// Mirrors `DeferredObjectiveHorizonStatus` in `lib/objectives/deferredObjectives/types`.
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
  // Mean-based estimate (no variance buffer). Paired with the buffered
  // `energyNeededKWh` so the UI can render an `expected…planned` range. Written
  // only when it differs from `energyNeededKWh`; absent means no buffer to show
  // (cold-start, bootstrap, steady device) and the UI treats it as equal to
  // `energyNeededKWh`. Optional for backward compatibility.
  energyExpectedKWh?: number;
  // Planner status. UI surfaces a "Can't fully meet" chip when this is
  // `cannot_meet` or `at_risk`.
  planStatus: DeferredObjectiveActivePlanStatusV1;
  // Source of the kWh-per-unit value the planner used. `bootstrap` means a
  // conservative default was used because no learned profile was available
  // yet; the next accepted sample will flip this to `learned`. Optional for
  // backward compatibility — older persisted revisions don't carry it and the
  // UI should treat absence as `learned`.
  kwhPerUnitSource?: DeferredObjectiveActivePlanKwhPerUnitSource;
  // Producer-resolved display rate (kWh per °C / %) for the plan-inputs row.
  // The recorder collapses the bootstrap-vs-learned branching the settings UI
  // used to do (`resolveKwhPerUnitDisplayRate`) into this flat value: the
  // learned profile mean, or the EV bootstrap constant when `speedMode` is
  // `learning`. The recorder OMITS the field entirely (absent, never written as
  // `null`) when no usable positive rate was resolved — the source
  // short-circuited or the rate wasn't a finite positive number. The `| null`
  // in the type is tolerated only so a hand-edited/forward-compat payload that
  // explicitly set it null still round-trips through the validator. Optional for
  // backward compatibility — older persisted revisions don't carry it and the UI
  // falls back to the live learned-profile mean.
  rateMean?: number | null;
  // Producer-resolved presentation-speed mode. See
  // `DeferredObjectiveActivePlanSpeedMode` for the enum + the
  // enum-not-human-string rationale. Optional for backward compatibility —
  // older persisted revisions don't carry it and the UI derives it from
  // `kwhPerUnitSource` (absent → `auto`).
  speedMode?: DeferredObjectiveActivePlanSpeedMode;
  // Number of horizon buckets whose per-bucket cap collapsed to zero because
  // the daily budget cap had already been reached. Lets the UI explain a
  // `cannot_meet` outcome that would otherwise look like a device or schedule
  // problem. Optional for backward compatibility — older persisted revisions
  // don't carry it and the UI should treat absence as zero.
  dailyBudgetExhaustedBucketCount?: number;
  // Producer-resolved verdict for what bound the floor schedule. See the
  // `DeferredObjectiveActivePlanFloorShortfallCause` doc above for the mapping
  // table and the squeeze-case rationale. Persisting it lets the hero copy
  // resolver route a `cannot_meet` / `at_risk` plan whose cause is `budget` to
  // the `Open Budget` recourse even when `dailyBudgetExhaustedBucketCount`
  // stays at zero (the per-bucket background squeeze case). Optional for
  // backward compatibility — legacy revisions without the field fall back to
  // the count-based heuristic so the consumer never branches on absence as a
  // signal in itself.
  floorShortfallCause?: DeferredObjectiveActivePlanFloorShortfallCause;
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
  // when source is 'bootstrap'. Band-aware when bands have fit (mirrors the
  // live `kwhPerUnit.confidence`, which Step 2 of the Cause-#1 fix re-resolves
  // against the pooled within-band residual), falls back to raw per-sample CV
  // otherwise — which on thermal devices sits at "low" effectively forever.
  // Kept on the provenance for logs/diagnostics; the chip reads
  // `displayConfidence` instead.
  confidence: 'low' | 'medium' | 'high' | null;
  // Band-aware aggregate driving the smart-task chip. Reflects whether the
  // bands actually integrated for this resolution are well-supported, not the
  // raw per-sample CV. Optional for backward compatibility — older persisted
  // plans fall back to `confidence`. Null when no learned profile yet.
  displayConfidence?: 'low' | 'medium' | 'high' | null;
  // Last accepted sample timestamp; null when there is no profile yet.
  lastAcceptedAtMs: number | null;
};

// Subset of diagnostic reason codes surfaced in the active-plan contract so
// the Settings UI can render specific device-card copy (e.g. "car unplugged")
// without knowing runtime-internal reason code strings. Optional so older
// persisted plans (without the field) continue to load.
export type DeferredObjectiveActivePlanDiagnosticReason =
  | 'objective_invalid_session';

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
  // Narrow diagnostic reason code set on the pending record when the cause is
  // a known specific device state (e.g. car unplugged). Undefined when the
  // pending cause is generic or when the plan has an active revision. Optional
  // for backward compatibility.
  diagnosticReasonCode?: DeferredObjectiveActivePlanDiagnosticReason;
  // The signature of the objective settings that produced `latest`. Used to
  // detect `objective_changed` replans without re-deriving the hash on every
  // load.
  objectiveSignature: string;
  // Snapshot of the planner's effective useful power (kW) at plan creation —
  // the value used when the *first* revision landed. Stable across subsequent
  // revisions so the hero meta line reflects the plan-level total duration the
  // user agreed to, not the shrinking "remaining" amount that drops as energy
  // is consumed each cycle. Optional for backward compatibility — older
  // persisted plans (or `objective_changed` replans, which reset the snapshot)
  // continue to load and the hero falls back to the per-revision values.
  initialPlanningSpeedKw?: number;
  // Pre-formatted "Yh Zm" snapshot matching `initialPlanningSpeedKw`. Frozen
  // at first-revision time alongside the speed so the meta-line surface stays
  // consistent across revisions. Optional for backward compatibility.
  initialEstimatedDurationText?: string;
  // Committed learned energy rate (kWh per °C or per % SoC) the deviation
  // detector compares the live learned rate against. Frozen when the plan is
  // first committed against a `learned`-source profile, re-baselined whenever a
  // `measured_deviation` revision fires (so a sustained drift is reported once,
  // and gradual drift re-arms after each report), and reset on
  // `objective_changed`. Absent when the committing diagnostic was still on the
  // bootstrap fallback (no learned rate yet) and on legacy persisted plans —
  // both mean "no baseline", so the detector stays silent. See
  // `hasLearnedRateDeviated` in `activePlanRecorder.ts`.
  initialKwhPerUnit?: number;
  // First full-horizon allocation accepted for this objective. Runtime uses
  // this as the committed schedule envelope on later plan cycles; fresh
  // optimizer output may update diagnostics, but it must not move the selected
  // hours unless the user abandons/replaces the objective. Optional so older
  // persisted plans continue to load as legacy advisory plans.
  commitment?: DeferredObjectiveActivePlanCommitmentV1;
  original: DeferredObjectiveActivePlanRevisionV1 | null;
  latest: DeferredObjectiveActivePlanRevisionV1 | null;
  // ── UI-derived live-progress fields (NEVER persisted) ──────────────────────
  // Populated only by the active-plans UI payload assembler
  // (`setup/deferredObjectiveActivePlansUiAssembler.ts`, called from
  // `app.getDeferredObjectiveActivePlansUiPayload`), which stitches the live
  // in-progress readings from the plan-history recorder onto the snapshot so the
  // smart-tasks widget can draw a planned-vs-actual trajectory while the run is
  // open. The active-plan store never writes these (the samples are persisted by
  // the history recorder, not duplicated here), so persistence round-trips and
  // the active-plan validator are unaffected — they are absent on every loaded
  // plan and present only on the assembled UI payload. Added 2026-06-02.
  //
  // `startProgress*` is the first observed reading of the run (the trajectory
  // anchor); `progressSamples` is the hourly observed series so far.
  startProgressC?: number | null;
  startProgressPercent?: number | null;
  progressSamples?: DeferredObjectiveActivePlanProgressSampleV1[];
  // Bounded, most-recent-first log of past revisions, capped at
  // `MAX_HISTORY_REVISIONS` entries in the recorder. The first element is the
  // revision that landed *before* `latest` (so the head is always "previous
  // commit"); `original` may also appear here once the task has lived past
  // its first revision. Optional for backward compatibility: legacy persisted
  // plans without the field load as if the history were empty, and the
  // recorder starts logging on the next replan. The UI's revision panel hides
  // itself when the array is empty or absent.
  history?: DeferredObjectiveActivePlanRevisionV1[];
};

export type DeferredObjectiveActivePlansV1 = {
  version: 1;
  plansByDeviceId: Record<string, DeferredObjectiveActivePlanV1>;
};
