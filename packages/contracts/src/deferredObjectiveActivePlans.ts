import type { DeferredObjectiveSettingsKind } from './deferredObjectiveSettings.js';
// Type-only file: runtime code must not value-import contracts per the
// packaging boundary. The schema version literal + top-level shape/version
// guard live in browser-safe shared-domain
// (`packages/shared-domain/src/deferredObjectiveActivePlanShape.ts`,
// `DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION`), shared by the runtime recorder and
// the settings UI.

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
  | 'direction_changed'
  | 'prices_revised'
  | 'schedule_revised'
  | 'rate_refined'
  | 'device_unavailable'
  | 'measured_deviation'
  // `flow_permission_changed` marks a revision caused only by a change to a smart
  // task's rescue permission; `resolveReplanReason` emits it when the rescue
  // signature is the only thing that changed. Distinct from `objective_changed`.
  | 'flow_permission_changed';

// Identifies whether the kWh-per-unit value used for the revision came from a
// learned profile, the bootstrap fallback, or is exact (an energy task, whose
// unit is kWh). Optional on the revision because the recorder omits it when no
// rate source was consulted — see the field.
export type DeferredObjectiveActivePlanKwhPerUnitSource = 'learned' | 'bootstrap' | 'exact';

// Producer-resolved presentation-speed mode for the hero meta line. The
// recorder collapses `kwhPerUnitSource` into this flat enum so the settings UI
// never branches on planner internals (`feedback_layering_resolution_in_producer`):
//   `learning` — the revision used the bootstrap kWh/% fallback (no learned
//                profile yet; EV cold-start only).
//   `auto`     — a learned profile drove the rate (the steady state).
// The human label strings ("Auto" / "Learning…") stay in the settings UI per
// `feedback_ui_text_shared_with_logs` — only the enum is persisted. `Manual`
// / `Conservative` are future modes that would extend this union if/when they
// ship. Optional on the revision for the same producer-side reason as
// `kwhPerUnitSource`; the UI derives it from that field (absent → `auto`).
export type DeferredObjectiveActivePlanSpeedMode = 'auto' | 'learning';

// Producer-resolved verdict for what bound the floor schedule on this revision.
// Mirrors the planner's `statusDetail` mapping in
// `lib/objectives/deferredObjectives/floorShortfallCause.ts` (`limited_by_daily_budget`
// → `budget`, `feasible_above_floor` → `step_power`, `estimate_uncertain` →
// `estimate`, `limited_by_higher_priority_task` → `higher_priority_load`,
// `target_cannot_be_met` → `time_capacity`, anything else → `none`).
// `higher_priority_load` and `time_capacity` both mean the task needs every hour
// it can get; they differ in what to tell the owner. `higher_priority_load` is
// proven by the contention overlay: without the higher-priority tasks' bookings
// and the devices above's reserved steps the same need fits, so the window is
// long enough and other devices take the room the house limit leaves.
// `time_capacity` is a window too short even then.
// Persisted so the hero copy resolver can route a `cannot_meet` / `at_risk` plan
// to the budget-bound recourse (`Open Budget`) without re-deriving cause from
// `dailyBudgetExhaustedBucketCount` — which fails on the per-bucket background
// squeeze case where the count stays at zero but the cause is still budget.
// Optional on the revision because the recorder suppresses the `none` case for
// byte-stability. On any plan a current build wrote, ABSENT MEANS "no
// shortfall" — do NOT read absence as "unknown" and fall back to the retired
// `(cannot_meet || at_risk) && bucketCount > 0` derivation. Active plans
// re-settle hourly and are deleted at the deadline, so no live plan predates
// this field.
export type DeferredObjectiveActivePlanFloorShortfallCause =
  | 'budget'
  | 'step_power'
  | 'estimate'
  | 'time_capacity'
  | 'higher_priority_load'
  | 'none';

// One booked time interval. The historical `hours` array name is retained in
// the wire format; every element now carries explicit source/coverage bounds.
// Zero-energy bookings claim free capacity only and are never energy floors.
export type DeferredObjectivePlanInterval = {
  startsAtMs: number;
  endsAtMs: number;
  plannedKWh: number;
  // Physical draw, separate from useful energy. Legacy records can lack it.
  plannedAdmissionPowerKw?: number;
  // Legacy partial coverage; absent means startsAtMs. New bookings use their
  // exact covered start directly. Energy always covers [coverageStart, endsAtMs).
  coversFromMs?: number;
  // Frozen cumulative unit target at this interval's end. A migrated/regridded
  // interval without its own saved target uses the energy milestone instead.
  plannedUnitMilestone?: number;
  // Frozen planning-price comparison against later booked intervals.
  cheaperHourAhead?: boolean;
};

export type DeferredObjectiveActivePlanCommitmentV1 = {
  committedAtMs: number;
  hours: DeferredObjectivePlanInterval[];
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

// Exact physical reservation for a booked allocation segment. A booking may
// combine adjacent pieces of one source period; these retain the individual
// step draw and source identity for lower-priority tasks and frozen replay.
// Legacy revisions may omit the segments and resolve them from their bookings.
export type DeferredObjectiveActivePlanReservationSegmentV1 = {
  startMs: number;
  endMs: number;
  plannedKWh: number;
  plannedAdmissionPowerKw: number;
  // Stable identity of the price-horizon bucket that produced this segment.
  // A current bucket's `startMs` is trimmed forward on each planning cycle,
  // while this id stays fixed; priority coordination uses it to distinguish a
  // real claim-topology change from the passage of time. Optional for plans
  // persisted before exact source-bucket identity shipped.
  sourceBucketId?: string;
};

export type DeferredObjectiveActivePlanRevisionV1 = {
  revision: number;
  revisedAtMs: number;
  computedFromPricesUpTo: number | null;
  reason: DeferredObjectiveActivePlanRevisionReason;
  // Direction used to produce this revision. Missing only on historical
  // heating-only records written before directional thermostat planning.
  progressDirection?: 'increasing' | 'decreasing' | 'unknown';
  hours: DeferredObjectivePlanInterval[];
  reservationSegments?: DeferredObjectiveActivePlanReservationSegmentV1[];
  // Total energy the planner thinks is required to meet the deadline. Lets the
  // UI render a meaningful timeline even when allocated hours sum to zero
  // (e.g. `cannot_meet` against a sub-second remaining bucket) and without
  // depending on a learned `kwhPerUnit` profile.
  energyNeededKWh: number;
  // Mean-based estimate (no variance buffer) of the energy STILL needed at this
  // revision's moment — `kWhPerUnit.mean × remainingUnits`, so it shrinks across
  // a run's revisions. Paired with the buffered `energyNeededKWh` so the UI can
  // render an `expected…planned` range. Written only when it differs from
  // `energyNeededKWh`; absent means no buffer to show (cold-start, bootstrap,
  // steady device) and is EQUAL to `energyNeededKWh` — a lossless byte-stability
  // omission, and the ordinary shape rather than a legacy one. Resolve it
  // through `resolveRemainingEnergyKWh`
  // (`packages/shared-domain/src/energyQuantities.ts`), never by substituting a
  // different quantity. One display formatter still spells the rule inline —
  // `formatEnergyEstimateKWh` in `packages/shared-domain/src/smartTaskCopy/liveDetailCopy.ts`,
  // which takes pre-resolved numbers rather than a revision; route it through
  // the resolver if its signature ever changes.
  energyExpectedKWh?: number;
  // Planner status. UI surfaces a "Can't fully meet" chip when this is
  // `cannot_meet` or `at_risk`.
  planStatus: DeferredObjectiveActivePlanStatusV1;
  // Source of the kWh-per-unit value the planner used. `bootstrap` means a
  // conservative default was used because no learned profile was available
  // yet; the next accepted sample will flip this to `learned`. Optional
  // because the RECORDER omits it whenever the diagnostic never consulted a
  // rate source (`activePlanRevisionBuild.ts`), not merely because older
  // revisions lack it — absence is an ordinary shape a current build writes.
  // Consumers treat absence as `learned`.
  kwhPerUnitSource?: DeferredObjectiveActivePlanKwhPerUnitSource;
  // Producer-resolved display rate (kWh per °C / %) for the plan-inputs row.
  // The recorder collapses the bootstrap-vs-learned branching the settings UI
  // used to do (`resolveKwhPerUnitDisplayRate`) into this flat value: the
  // learned profile mean, or the EV bootstrap constant when `speedMode` is
  // `learning`. The recorder OMITS the field entirely (absent, never written as
  // `null`) when no usable positive rate was resolved — the source
  // short-circuited or the rate wasn't a finite positive number. The `| null`
  // in the type is tolerated only so a hand-edited/forward-compat payload that
  // explicitly set it null still round-trips through the validator. That
  // producer-side omission is why the field is optional, not legacy data;
  // consumers read the plan's rate through `resolvePlanKwhPerUnit`, which falls
  // back to the provenance's learned mean, never the live profile.
  rateMean?: number | null;
  // Producer-resolved presentation-speed mode. See
  // `DeferredObjectiveActivePlanSpeedMode` for the enum + the
  // enum-not-human-string rationale. Optional on the same condition as
  // `kwhPerUnitSource` above — the recorder writes both or neither, so a
  // current build omits it whenever no rate source resolved. The UI derives it
  // from `kwhPerUnitSource` (absent → `auto`).
  speedMode?: DeferredObjectiveActivePlanSpeedMode;
  // Producer-resolved verdict for what bound the floor schedule. See the
  // `DeferredObjectiveActivePlanFloorShortfallCause` doc above for the mapping
  // table and the squeeze-case rationale. Persisting it lets the hero copy
  // resolver route a `cannot_meet` / `at_risk` plan whose cause is `budget` to
  // the `Open Budget` recourse even when `dailyBudgetExhaustedBucketCount`
  // stays at zero (the per-bucket background squeeze case). Optional because
  // the recorder suppresses the `none` case for byte-stability, so on a current
  // build ABSENT MEANS "no shortfall" — an ordinary shape, not a legacy one.
  // Consumers must not read absence as "unknown".
  floorShortfallCause?: DeferredObjectiveActivePlanFloorShortfallCause;
  // The soft daily budget had a hand in this shortfall: with the per-bucket cap
  // lifted, the climbed-band allocation places strictly more energy. Measured
  // between two CLIMBED allocations, capped against uncapped, so the ladder's own
  // contribution is not credited to the budget; not a claim about the floor plan,
  // which a cap above the floor rung never touches. Independent of the cause above
  // — when the budget explains the shortfall OUTRIGHT the cause is already
  // `budget`; this also covers the case where uncapping helps but the target
  // still misses, which the cause alone reports as `time_capacity`. Stamped only
  // when true, so on a current build ABSENT MEANS "the budget was not
  // implicated". Consumers must not read absence as "unknown".
  budgetContributedToShortfall?: true;
  // Planner's effective useful power (kW) used to estimate hours-of-work for
  // the current plan. Surfaced in the hero meta line ("Y.Y kW") so the user
  // can sanity-check estimated duration. Optional because the recorder writes
  // it only when the planner resolved a finite positive speed; absence is an
  // ordinary shape a current build produces.
  planningSpeedKw?: number;
  // Pre-formatted estimated duration ("Yh Zm") matching `planningSpeedKw`.
  // Lives on the revision so all surfaces format consistently with the math
  // the planner actually used. Optional on the same condition as
  // `planningSpeedKw`: no resolvable speed means no duration to format.
  estimatedDurationText?: string;
  // Stable signature of the smart-task prefix, order, objective settings, and
  // higher-task claim topology used for this allocation. A mismatch forces an
  // immediate coordinated replan; ordinary higher-task energy/rate drift on an
  // unchanged set of claimed intervals still obeys the hourly settle gate.
  allocationContextSignature?: string;
};

export type DeferredObjectiveActivePlanPendingReason =
  // Seeded the moment the user creates or edits the task, before the allocator
  // has run for the first time. Nothing is blocking — the recorder simply has
  // no diagnostic yet, so it cannot name a cause. Also the resolved default for
  // legacy records persisted before `pendingReason` existed: consumers must not
  // read absence as any particular blocker.
  | 'not_yet_planned'
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing'
  | 'waiting_for_car'
  // EV plugged-out / discharging — surfaced as a paused state in the UI.
  | 'invalid_session'
  // Thermal device with no learned `kWhPerUnit` profile yet — the planner has
  // no shipped bootstrap rate for thermal kinds, so it sits pending until
  // accepted samples produce a profile.
  | 'missing_capacity'
  // The task's device now belongs to a separately-metered home. Smart tasks
  // are main-home-only in the current scope, so no revision can be produced
  // until the device returns to the main home.
  | 'device_in_sub_home'
  // The owner turned "Managed by PELS" off for the task's device. PELS plans
  // only managed devices, so the task pauses (it is never deleted) and resumes
  // the moment the device is managed again.
  | 'device_unmanaged';

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
  | 'objective_invalid_session'
  | 'objective_waiting_for_car'
  // Live home-scope truth. Kept on committed plans with a cached revision so
  // consumers can override that stale schedule while the task is out of scope.
  | 'objective_device_in_sub_home'
  // Confirmed device-side delivery causes the committed schedule cannot see:
  // the device stopped accepting energy, stopped at its own limit (an EV's
  // charge limit), or is held by its own schedule. Planner decisions (capacity,
  // budget, priority limiting, settles) never travel here; the committed
  // verdict already prices them in.
  | 'objective_not_accepting_energy'
  | 'objective_device_limit'
  | 'objective_device_schedule'
  // The task's device is not managed by PELS. Same live-truth reason as
  // `objective_device_in_sub_home`: a committed plan keeps advertising its
  // cached schedule until the next settle, so the pause has to travel on the
  // plan itself.
  | 'objective_device_unmanaged';

/** The car's own charge limit capping an EV task: see `DeferredObjectiveActivePlanV1.carChargeLimit`. */
export type DeferredObjectiveActivePlanCarChargeLimitV1 = {
  limitValue: number;
  reached: boolean;
};

/** Current completion is independent of the immutable allocation revision. */
export type DeferredObjectiveLiveCompletion =
  | { kind: 'unavailable' }
  | { kind: 'satisfied' }
  | { kind: 'unmet'; status: 'on_track' | 'at_risk' | 'cannot_meet' };

export type DeferredObjectiveActivePlanV1 = {
  liveCompletion: DeferredObjectiveLiveCompletion;
  deviceId: string;
  deviceName: string | null;
  objectiveKind: DeferredObjectiveSettingsKind;
  // The target in the task's own unit (°C, % or kWh; `objectiveKind` names
  // it). A plan stored before this field carried the target in its kind's own
  // column (`targetTemperatureC` or `targetPercent`); the loader reads that once.
  targetValue: number;
  deadlineAtMs: number;
  startedAtMs: number;
  pending: boolean;
  // Per-plan provenance snapshot: the rate source, learned mean and confidence
  // the plan was built with. Optional because the recorder writes it only once
  // a rate source resolved; consumers treat absence as "no signal" (no
  // confidence chip, no learned rate), never as a cue to read the live profile.
  kwhPerUnitProvenance?: DeferredObjectiveKwhPerUnitProvenanceV1;
  // Only meaningful when `pending` is true. Identifies why the recorder
  // couldn't produce a revision (e.g. price-aware optimisation off vs prices
  // not yet covering the horizon). Optional so older persisted plans without
  // this field continue to load.
  pendingReason?: DeferredObjectiveActivePlanPendingReason;
  // Narrow diagnostic reason code set when a known live blocker must override
  // plan state (e.g. car unplugged or device on a separate meter). It can remain
  // present on a committed record with a cached revision so consumers do not
  // advertise that stale schedule. Optional for backward compatibility.
  diagnosticReasonCode?: DeferredObjectiveActivePlanDiagnosticReason;
  // Present only while the car's own charge limit sits below an EV task's
  // target: the car's limit, and whether the car has reached it. The requested
  // target stays the task's target; the limit only explains why delivery stops
  // short of it, and the surfaces suggest raising the car's limit. Refreshed
  // every cycle the device reports a level, held while it reports none (a
  // charger that ended the session at the limit reads unplugged), so a task
  // whose car stopped at its limit is not mistaken for an unplugged one.
  carChargeLimit?: DeferredObjectiveActivePlanCarChargeLimitV1;
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
  // this as the committed schedule envelope on later plan cycles. Ordinary
  // optimizer churn cannot move it; a coordinated higher-priority smart-task
  // allocation may replace its current/future hours explicitly. Optional so
  // older persisted plans continue to load as legacy advisory plans.
  commitment?: DeferredObjectiveActivePlanCommitmentV1;
  original: DeferredObjectiveActivePlanRevisionV1 | null;
  latest: DeferredObjectiveActivePlanRevisionV1 | null;
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

export type DeferredObjectiveActivePlansV2 = {
  version: 2;
  plansByDeviceId: Record<string, DeferredObjectiveActivePlanV1>;
};

// A reading of the task's progress while its run is in flight, in the task's
// own unit. Structurally identical to
// `ResolvedDeferredObjectivePlanHistoryProgressSample` in
// `deferredObjectivePlanHistory.ts`, but duplicated here on purpose:
// `deferredObjectivePlanHistory.ts` already imports from THIS file
// (`DeferredObjectivePlanInterval` / `…StatusV1`), so importing the history
// sample type back here would close a circular dependency (rejected by the
// `no-circular` dep-cruiser rule). The shapes are identical so values flow
// between the two structurally.
export type ResolvedDeferredObjectiveActivePlanProgressSampleV1 = {
  atMs: number;
  value: number | null;
};

// The live in-progress readings of a run, from the plan-history recorder's
// in-flight record: `startProgressValue` is the first trustworthy reading of the
// run (the trajectory anchor), `progressSamples` the 15-minute observed series
// so far. Stitched onto the UI view of the active plan so the smart-tasks widget
// can draw planned-vs-actual progress while the run is open; the active-plan
// store never holds them.
export type DeferredObjectiveActivePlanTrajectory = {
  startProgressValue: number | null;
  progressSamples: ResolvedDeferredObjectiveActivePlanProgressSampleV1[];
};

type ResolvedDeferredObjectiveActivePlanBase = Omit<
  DeferredObjectiveActivePlanV1,
  'progressDirection' | 'objectiveKind'
> & {
  // Resolved from the latest revision at the producer boundary. Legacy plans
  // without a direction retain their historical increasing interpretation.
  progressDirection: 'increasing' | 'decreasing' | 'unknown';
  // The run's live trajectory (`DeferredObjectiveActivePlanTrajectory`), absent
  // on a plan with no open run to read it from.
  startProgressValue?: number | null;
  progressSamples?: ResolvedDeferredObjectiveActivePlanProgressSampleV1[];
};

// Consumer-facing view of an active plan, built by `toResolvedActivePlan` at the
// producer boundary (the UI payload assembler). Every value is in the task's own
// unit. A task's reading right now: an energy task's is the energy delivered
// since it started (`deliveredKWh`, from the runtime's delivery count, the same
// count the runtime plans from), because the device has no level this task is
// measured by; every other kind reads a level off the device, which the page
// has on the device itself. Only on this UI view: the stored plan never has it.
export type ResolvedDeferredObjectiveActivePlanV1 =
  | (ResolvedDeferredObjectiveActivePlanBase & { objectiveKind: 'energy'; deliveredKWh: number })
  | (ResolvedDeferredObjectiveActivePlanBase & { objectiveKind: 'temperature' | 'ev_soc' });

/** Energy fed to `deviceId` under its task ending at `deadlineAtMs`, in kWh. */
export type DeliveredEnergyReader = (deviceId: string, deadlineAtMs: number) => number;

export type ResolvedDeferredObjectiveActivePlansV2 = {
  version: 2;
  plansByDeviceId: Record<string, ResolvedDeferredObjectiveActivePlanV1>;
};

// Narrow read-only view for the Overview surfaces — the ONLY fields the
// Overview reads off the separately-loaded active-plans state
// (`coerceDeferredObjectiveActivePlans` / `state.deferredObjectiveActivePlans`):
// the device-card EV-state line (`latest.hours` + `diagnosticReasonCode`) and
// the smart-task readiness row (`pending`/`pendingReason` +
// `latest.planStatus` for `resolveSmartTaskListStatus`, plus
// `deviceName`/`deadlineAtMs` for its copy).
// That state is seeded once from the resolved bootstrap payload and then
// replaced by the same resolved view on every
// `deferred_objective_active_plans_updated` push. Typing the Overview state to
// this narrow shape makes reading a value column there a compile error. The deadline-plan
// surfaces read the fully-resolved `bootstrap.deferredObjectiveActivePlans`
// instead, never this state.
export type OverviewDeferredObjectiveActivePlan = Pick<
  DeferredObjectiveActivePlanV1,
  'latest' | 'diagnosticReasonCode' | 'pending' | 'pendingReason' | 'deviceName' | 'deadlineAtMs' | 'carChargeLimit'
  | 'liveCompletion' | 'targetValue'
>;

export type OverviewDeferredObjectiveActivePlans = {
  version: 2;
  plansByDeviceId: Record<string, OverviewDeferredObjectiveActivePlan>;
};
