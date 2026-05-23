import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryHourlyContribution,
  DeferredObjectivePlanHistoryHourlyTone,
  DeferredObjectivePlanHistoryObservedInterval,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  DeferredObjectivePlanHistoryV4,
  DeferredObjectivePlanMetReason,
  DeferredObjectivePlanOutcome,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION } from './planHistorySettings';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import { buildEndedEventFromEntry, type DeferredObjectiveEndedBus } from './endedEventBus';
import {
  appendHourlyContribution,
  appendRevisionLogIfNew,
  buildFinalHourFlush,
  buildFinalizedAttributionEvent,
  captureRevisionSnapshot,
  detectHourRollover,
  drainProgressSamples,
  hasTrustworthyProgress,
  hourBucketMs,
  type HourPriceResolver,
  type HourProgressSnapshot,
  pickKwhPerUnit,
  recordProgressSample,
  seedProgressSamples,
} from './planHistoryV4Helpers';
import { randomUUID } from 'node:crypto';
// Cap the rolling buffer. One deferred objective produces at most one entry per deadline run
// (per-day for HH:mm objectives), so 30 entries covers ~one month of history per device for a
// single-device household and shorter spans for multi-device homes. Bounded JSON size keeps
// startup reads cheap on Homey Pro.
const HISTORY_ENTRY_CAP = 30;

// If a previously-tracked diagnostic stops appearing for this long while its deadline is still
// in the future, treat the run as abandoned (settings disabled, device removed, evaluator
// dropped to unknown for an extended stretch).
const ABANDON_GRACE_MS = 60 * 60 * 1000;

// Two consecutive observations closer than this are merged into one observed interval. A larger
// gap leaves a hole the UI can surface as "we weren't watching during that span." Picked to
// absorb normal rebuild jitter (a few seconds to a couple of minutes) without hiding genuine
// downtime windows.
const INTERVAL_MERGE_GAP_MS = 5 * 60 * 1000;

type ObservedInterval = DeferredObjectivePlanHistoryObservedInterval;

type InProgressKey = string; // `${deviceId}|${deadlineAtMs}`

type InProgressRecord = Omit<
  DeferredObjectivePlanHistoryEntry,
  'id'
  | 'finalizedAtMs'
  | 'outcome'
  | 'discoveredFrom'
  | 'originalPlan'
  | 'finalPlan'
  | 'revisionCount'
  | 'progressSamples'
  | 'deliveredKWh'
  | 'totalCost'
  | 'revisions'
  | 'hourlyContributions'
  | 'metReason'
> & {
  satisfied: boolean;
  // `null` for target-reached / in-flight; `'stalled'` once the idle
  // classifier promoted the run. Sticky, reset only by clearSatisfiedWithProgress.
  metReason: DeferredObjectivePlanMetReason | null;
  // True original plan for this run, captured the first cycle an active plan
  // exists for `(deviceId, deadlineAtMs)`. We snapshot `plan.original` when
  // it's present so a recorder picking up mid-run (app restart, back-fill)
  // still records the run's true starting shape rather than a current
  // revision; falls back to `plan.latest` only when `original` is absent.
  // Never overwritten once set.
  originalPlan: DeferredObjectivePlanHistoryRevisionSnapshot | null;
  // Most recent `latest` revision observed for this run. Replaced on every
  // cycle that carries a fresh revision so finalization snapshots the truly
  // final plan, not the first one.
  finalPlan: DeferredObjectivePlanHistoryRevisionSnapshot | null;
  // Highest `plan.latest.revision` index observed for this run. Tracks the
  // total number of revisions written by the active-plan recorder so the
  // history detail can show "Replanned N times". 0 when no plannable
  // revision was ever observed.
  revisionCount: number;
  // Hourly downsample of progress observations, keyed by hour-aligned `atMs`.
  // Each cycle upserts the latest reading for the current hour; cap is
  // applied at drain so the in-memory map stays bounded even for runs that
  // somehow exceed the cap. Drained into the entry at finalization.
  progressSamples: Map<number, DeferredObjectivePlanHistoryProgressSample>;
  // Total useful kWh delivered to the device across the run. Summed from
  // `recordHourlyDelivery` contributions; persisted only when at least one
  // contribution was recorded so empty runs stay byte-stable across upgrades.
  deliveredKWh: number;
  // Σ priceValue × deliveredKWh across the run, in the user's display
  // currency. Tracked alongside `deliveredKWh` so the persisted ratio
  // (cost / delivered) stays internally consistent.
  totalCost: number;
  // Becomes true on the first `recordHourlyDelivery` contribution so
  // `deliveredKWh` and `totalCost` are persisted (as `0` if needed) rather
  // than dropped. Without this flag a run with one zero-priced delivered
  // hour would look identical to a run that never received a contribution.
  hasDeliveryContribution: boolean;
  // Chronological per-revision metadata appended each time the active plan's
  // `latest.revision` index increases. Bounded implicitly by the active-plan
  // recorder's per-cycle dedupe — `prices_revised` and `rate_refined` only
  // fire when the underlying inputs actually changed, so realistic runs see
  // ~5-10 entries at most. No explicit cap; tracked in `TODO.md` as a v2.7.2
  // follow-up if a pathological replan loop ever surfaces.
  revisions: DeferredObjectivePlanHistoryRevisionLogEntry[];
  // Per-hour delivery contributions appended on every `recordHourlyDelivery`
  // call. Each entry mirrors one contribution: hour-aligned `atMs`,
  // delivered kWh, the spot-price the recorder summed into `totalCost`, and
  // the price tone the caller resolved. The postmortem bar strip
  // (`DeadlinePlanHistoryDetail`) reads this list to render one bar per
  // hour. Persisted only when at least one contribution was recorded —
  // empty runs stay byte-stable across upgrades, gated by
  // `hasDeliveryContribution` the same way `deliveredKWh` / `totalCost`
  // are.
  hourlyContributions: DeferredObjectivePlanHistoryHourlyContribution[];
  // First trustworthy progress reading observed in the currently-open hour.
  // The internal hour-rollover detector uses this as the "hour opening"
  // anchor — when the next observation lands in a later hour bucket, the
  // delta (opening → latest reading in the closing hour) is converted to
  // delivered kWh using `lastKWhPerUnit` and emitted as a contribution.
  // `null` when no trustworthy reading has been observed yet (cold start,
  // sensor offline) so the rollover skips emission until coverage resumes.
  //
  // Lossy-restart contract: this field is **not persisted** across PELS
  // restarts. The in-progress map is rebuilt from live diagnostics, so a
  // restart mid-run re-anchors the opening at the post-restart reading.
  // Any progress delivered between the pre-restart opening and the first
  // post-restart observation is lost from the postmortem strip (it lands
  // in *neither* hour). Persisting requires a new settings key — tracked
  // in `TODO.md`. See `restarts mid-run drop the in-flight hour anchor`
  // regression test below for the pinned behaviour.
  currentHourOpening: HourProgressSnapshot | null;
  // Effective kWh-per-unit factor from the most recent diagnostic. Cached
  // on the record so `finalizeRecord` can flush the still-open hour's
  // contribution without re-reading a diagnostic (the finalization paths
  // — `finalizeStaleRecords`, `finalizeForUserChange` — do not carry one).
  // `null` when no diagnostic ever resolved a profile. Same lossy-restart
  // contract as `currentHourOpening` — see above.
  lastKWhPerUnit: number | null;
};


const pickRevisionForOriginal = (
  plan: DeferredObjectiveActivePlanV1 | undefined,
): DeferredObjectiveActivePlanRevisionV1 | null => {
  if (!plan) return null;
  // True original capture: prefer `plan.original` so a recorder starting
  // mid-run (app restart / back-fill picking up an already-replanned plan)
  // still records the run's actual starting shape rather than a current
  // revision. Falls back to `latest` only when no original exists yet.
  return plan.original ?? plan.latest ?? null;
};

const pickRevisionForFinal = (
  plan: DeferredObjectiveActivePlanV1 | undefined,
): DeferredObjectiveActivePlanRevisionV1 | null => {
  if (!plan) return null;
  // Final capture follows the live detail view: `latest` is what the UI
  // charts. Falls back to `original` for pending plans where no `latest`
  // revision has been produced yet.
  return plan.latest ?? plan.original ?? null;
};

const findPlanForRecord = (
  plans: DeferredObjectiveActivePlansV1 | null,
  record: { deviceId: string; deadlineAtMs: number },
): DeferredObjectiveActivePlanV1 | undefined => {
  if (!plans) return undefined;
  const plan = plans.plansByDeviceId[record.deviceId];
  if (!plan) return undefined;
  // A persisted plan with a different deadline belongs to a different run.
  if (plan.deadlineAtMs !== record.deadlineAtMs) return undefined;
  return plan;
};

const buildKey = (deviceId: string, deadlineAtMs: number): InProgressKey => (
  `${deviceId}|${deadlineAtMs}`
);

const isPlannableStatus = (status: DeferredObjectiveDiagnostic['status']): boolean => (
  status !== 'unknown' && status !== 'invalid'
);

const isSatisfiedStatus = (status: DeferredObjectiveDiagnostic['status']): boolean => (
  status === 'satisfied'
);

const captureProgressC = (diag: DeferredObjectiveDiagnostic): number | null => (
  diag.objectiveKind === 'temperature' ? diag.currentTemperatureC : null
);

const captureProgressPercent = (diag: DeferredObjectiveDiagnostic): number | null => (
  diag.objectiveKind === 'ev_soc' ? diag.currentPercent : null
);

const diagnosticProgressAtTarget = (diag: DeferredObjectiveDiagnostic): boolean => {
  if (diag.objectiveKind === 'temperature') {
    if (diag.currentTemperatureC === null) return false;
    return diag.currentTemperatureC >= diag.targetTemperatureC;
  }
  if (diag.currentPercent === null || diag.targetPercent === null) return false;
  return diag.currentPercent >= diag.targetPercent;
};

const lastObservedAtMs = (record: InProgressRecord): number => {
  const { observedIntervals } = record;
  if (observedIntervals.length === 0) return record.startedAtMs;
  return observedIntervals[observedIntervals.length - 1]!.toMs;
};

const extendIntervals = (
  intervals: readonly ObservedInterval[],
  nowMs: number,
): ObservedInterval[] => {
  if (intervals.length === 0) return [{ fromMs: nowMs, toMs: nowMs }];
  const last = intervals[intervals.length - 1]!;
  if (nowMs <= last.toMs) return intervals.slice();
  if (nowMs - last.toMs <= INTERVAL_MERGE_GAP_MS) {
    return [...intervals.slice(0, -1), { fromMs: last.fromMs, toMs: nowMs }];
  }
  return [...intervals, { fromMs: nowMs, toMs: nowMs }];
};

// Returns whichever snapshot has the richer (longer) hour schedule. Ties keep
// the existing snapshot so we don't churn identity on byte-equivalent
// schedules. `null` always loses to a real snapshot.
const pickRicherSnapshot = (
  current: DeferredObjectivePlanHistoryRevisionSnapshot | null,
  candidate: DeferredObjectivePlanHistoryRevisionSnapshot | null,
): DeferredObjectivePlanHistoryRevisionSnapshot | null => {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate.hours.length > current.hours.length ? candidate : current;
};

const startRecord = (
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord | null => {
  if (diag.deadlineAtMs === null) return null;
  const currentlySatisfied = isSatisfiedStatus(diag.status);
  const originalRevision = pickRevisionForOriginal(plan);
  const finalRevision = pickRevisionForFinal(plan);
  const originalSnapshot = originalRevision ? captureRevisionSnapshot(originalRevision, plan) : null;
  const finalSnapshot = finalRevision ? captureRevisionSnapshot(finalRevision, plan) : null;
  return {
    deviceId: diag.deviceId,
    deviceName: diag.deviceName ?? null,
    objectiveKind: diag.objectiveKind,
    targetTemperatureC: diag.objectiveKind === 'temperature' ? diag.targetTemperatureC : null,
    targetPercent: diag.targetPercent,
    deadlineAtMs: diag.deadlineAtMs,
    startedAtMs: nowMs,
    startProgressC: captureProgressC(diag),
    startProgressPercent: captureProgressPercent(diag),
    finalProgressC: captureProgressC(diag),
    finalProgressPercent: captureProgressPercent(diag),
    initialEnergyNeededKWh: diag.energyNeededKWh ?? 0,
    metAtMs: currentlySatisfied ? nowMs : null,
    usedDeadlineReserve: diag.horizonPlan?.usesDeadlineReserve ?? false,
    usedPolicyAvoid: diag.horizonPlan?.usesPolicyAvoid ?? false,
    observedIntervals: [{ fromMs: nowMs, toMs: nowMs }],
    satisfied: currentlySatisfied,
    metReason: null,
    // Seed `originalPlan` with the richer of `plan.original` / `plan.latest`
    // so a recorder picking up mid-run after the planner has already expanded
    // the schedule does not anchor on a stale first revision. Subsequent
    // cycles refine via `refreshPlanSnapshots`.
    originalPlan: pickRicherSnapshot(originalSnapshot, finalSnapshot),
    finalPlan: finalSnapshot,
    revisionCount: resolveRevisionCount(plan),
    progressSamples: seedProgressSamples(diag, nowMs),
    deliveredKWh: 0,
    totalCost: 0,
    hasDeliveryContribution: false,
    revisions: [],
    hourlyContributions: [],
    currentHourOpening: seedHourOpening(diag, nowMs),
    lastKWhPerUnit: pickKwhPerUnit(diag),
  };
};

// Anchor the hour-rollover detector at run start. We adopt the first
// trustworthy reading as the opening of the current hour so a run that
// starts mid-hour and finalizes inside the same hour can still flush a
// contribution at finalize-time. Returns null when the start diagnostic
// carries no trustworthy progress — the rollover detector will adopt the
// first later cycle that does.
const seedHourOpening = (
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
): HourProgressSnapshot | null => {
  if (!hasTrustworthyProgress(diag)) return null;
  const value = diag.objectiveKind === 'temperature' ? diag.currentTemperatureC : diag.currentPercent;
  if (value === null) return null;
  return { hourMs: hourBucketMs(nowMs), value };
};


// Highest `latest.revision` index observed for this plan. The recorder
// increments revisions monotonically (see `activePlanRecorder.maybeWriteReplanRevision`),
// so reading `latest.revision` is the same as counting revisions written. Falls
// back to `original.revision` when only `original` is set (mid-run pickup
// before the first `latest` write). Returns 0 when no revision is recorded
// yet so the count stays consistent with "never replanned" copy.
const resolveRevisionCount = (
  plan: DeferredObjectiveActivePlanV1 | undefined,
): number => {
  if (!plan) return 0;
  const candidate = plan.latest?.revision ?? plan.original?.revision ?? 0;
  return Math.max(0, candidate);
};

const refreshPlanSnapshots = (
  record: InProgressRecord,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): Pick<InProgressRecord, 'originalPlan' | 'finalPlan' | 'revisionCount' | 'revisions'> => {
  const finalRevision = pickRevisionForFinal(plan);
  // Revision count is monotonic. Track the highest index ever observed so a
  // transient `plan` regression (planner cleared `latest` after a settings
  // glitch, mid-run pickup) does not reset the count we hand to history.
  const nextRevisionCount = Math.max(record.revisionCount, resolveRevisionCount(plan));
  if (!finalRevision) {
    return {
      originalPlan: record.originalPlan,
      finalPlan: record.finalPlan,
      revisionCount: nextRevisionCount,
      revisions: record.revisions,
    };
  }
  const finalSnapshot = captureRevisionSnapshot(finalRevision, plan);
  // `originalPlan` tracks the richest schedule the planner ever achieved for
  // this run, not strictly the first revision. The first written revision can
  // be a degenerate 1-hour allocation (prices arrived late, profile
  // bootstrapping) that the planner later expands into the full intended
  // window once it has more information. If we froze on the first revision,
  // a run that later collapsed back to a short schedule by deadline would
  // misrepresent both the intent ("we wanted 8 charging hours") and the
  // outcome ("only 1 of those happened"). Compare against `plan.latest` too
  // because intermediate replans frequently have more hours than
  // `plan.original`.
  const originalRevision = pickRevisionForOriginal(plan);
  const originalCandidate = originalRevision ? captureRevisionSnapshot(originalRevision, plan) : null;
  const nextOriginal = pickRicherSnapshot(
    pickRicherSnapshot(record.originalPlan, originalCandidate),
    finalSnapshot,
  );
  // Append a revision-log entry the first time we observe a higher
  // `latest.revision` than what we already logged. Skip the seed revision
  // (`revision === 1`) — its metadata is on `originalPlan`. Idempotent so a
  // cycle that observes the same plan twice doesn't double-log.
  const revisions = appendRevisionLogIfNew(record.revisions, record.finalPlan, finalRevision);
  return {
    originalPlan: nextOriginal,
    finalPlan: finalSnapshot,
    revisionCount: nextRevisionCount,
    revisions,
  };
};


// Back-fill `startProgressC` / `startProgressPercent` from the first cycle
// that actually carries a fresh reading. `startRecord` stamps both fields
// from the first diagnostic the recorder sees, but Homey SDK reads can
// transiently fail (per `feedback_homey_sdk_unreliable` — see
// `notes/smart-task-ui/README.md` for the live-walk regression), so a run
// that starts with `currentTemperatureC: null` / `currentPercent: null`
// would otherwise carry that null all the way to finalization. The history
// formatter (`packages/shared-domain/src/deferredPlanHistory.ts`) returns
// `null` for the progress line when the start value is null, hiding the
// run from the past-tasks list. Adopting the first non-null reading keeps
// "start" semantically meaning "first observed progress" rather than
// "snapshot at create-time, even if it was missing". Once set, the value
// is sticky — later cycles must not overwrite it.
const backfillStartProgress = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
): Pick<InProgressRecord, 'startProgressC' | 'startProgressPercent'> => ({
  startProgressC: record.startProgressC ?? captureProgressC(diag),
  startProgressPercent: record.startProgressPercent ?? captureProgressPercent(diag),
});


// Both stall variants behave identically against re-open / drift checks —
// "device went as far as it would go" is terminal whether the plateau sat
// inside the hysteresis band (`'stalled'`) or against the device's own cap
// (`'stalled_device_capped'`).
const isStallMetReason = (reason: DeferredObjectivePlanMetReason | null): boolean => (
  reason === 'stalled' || reason === 'stalled_device_capped'
);

// Stall-promoted records freeze `satisfied` and `finalProgress*` at the
// plateau reading. Without the freeze, post-stall samples would
// overwrite "as warm as the device would hold" and the next plannable
// tick would re-derive `currentlySatisfied = false` and unflag the run.
const computeMergedMetState = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
): {
  satisfied: boolean;
  metAtMs: number | null;
  finalProgressC: number | null;
  finalProgressPercent: number | null;
} => {
  const stallPromoted = record.satisfied && isStallMetReason(record.metReason);
  if (stallPromoted) {
    return {
      satisfied: true,
      metAtMs: record.metAtMs,
      finalProgressC: record.finalProgressC,
      finalProgressPercent: record.finalProgressPercent,
    };
  }
  const currentlySatisfied = isSatisfiedStatus(diag.status);
  return {
    satisfied: currentlySatisfied,
    metAtMs: currentlySatisfied ? (record.metAtMs ?? nowMs) : null,
    finalProgressC: captureProgressC(diag) ?? record.finalProgressC,
    finalProgressPercent: captureProgressPercent(diag) ?? record.finalProgressPercent,
  };
};

const mergeRecord = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord => {
  const merged = computeMergedMetState(record, diag, nowMs);
  return {
    ...record,
    deviceName: diag.deviceName ?? record.deviceName,
    ...backfillStartProgress(record, diag),
    finalProgressC: merged.finalProgressC,
    finalProgressPercent: merged.finalProgressPercent,
    usedDeadlineReserve: record.usedDeadlineReserve || (diag.horizonPlan?.usesDeadlineReserve ?? false),
    usedPolicyAvoid: record.usedPolicyAvoid || (diag.horizonPlan?.usesPolicyAvoid ?? false),
    observedIntervals: extendIntervals(record.observedIntervals, nowMs),
    satisfied: merged.satisfied,
    metAtMs: merged.metAtMs,
    progressSamples: recordProgressSample(record.progressSamples, diag, nowMs),
    ...refreshPlanSnapshots(record, plan),
  };
};

const clearSatisfiedWithProgress = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord => {
  return {
    ...record,
    deviceName: diag.deviceName ?? record.deviceName,
    ...backfillStartProgress(record, diag),
    finalProgressC: captureProgressC(diag) ?? record.finalProgressC,
    finalProgressPercent: captureProgressPercent(diag) ?? record.finalProgressPercent,
    observedIntervals: extendIntervals(record.observedIntervals, nowMs),
    satisfied: false,
    metAtMs: null,
    metReason: null,
    progressSamples: recordProgressSample(record.progressSamples, diag, nowMs),
    ...refreshPlanSnapshots(record, plan),
  };
};

const recordObservedTick = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord => ({
  ...record,
  ...backfillStartProgress(record, diag),
  observedIntervals: extendIntervals(record.observedIntervals, nowMs),
  progressSamples: recordProgressSample(record.progressSamples, diag, nowMs),
  ...refreshPlanSnapshots(record, plan),
});

// Promote a run to satisfied(stalled) when the classifier reports a stall
// shape — `near_target_idle` (device parked inside the hysteresis band) or
// `capped_idle` (device parked at its own internal cap below the PELS
// target). Idempotent — already-satisfied records pass through. The
// `reason` carries the distinct cause into the persisted entry so the
// postmortem can render the right recourse copy. The promotion snapshots
// `finalProgress*` from the diagnostic when it carries trustworthy
// progress; non-plannable ticks route through `recordObservedTick` which
// doesn't refresh `finalProgress*`, so without the capture here the freeze
// would pin to the previous plannable tick's value rather than the
// plateau reading.
const promoteRecordToStalled = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  reason: DeferredObjectivePlanMetReason,
): InProgressRecord => {
  if (record.satisfied) return record;
  const captureFromDiag = hasTrustworthyProgress(diag);
  return {
    ...record,
    finalProgressC: captureFromDiag
      ? (captureProgressC(diag) ?? record.finalProgressC)
      : record.finalProgressC,
    finalProgressPercent: captureFromDiag
      ? (captureProgressPercent(diag) ?? record.finalProgressPercent)
      : record.finalProgressPercent,
    satisfied: true,
    metAtMs: nowMs,
    metReason: reason,
  };
};

// Producer-side translation of observer-layer classifier output to the
// persisted `metReason`. `unresponsive` deliberately returns null so a
// tripped breaker doesn't get silently called "succeeded".
const stallClassificationToMetReason = (
  classification: 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined,
): DeferredObjectivePlanMetReason | null => {
  if (classification === 'near_target_idle') return 'stalled';
  if (classification === 'capped_idle') return 'stalled_device_capped';
  return null;
};

const recordNonPlannableTick = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord => {
  // Stalled records skip the re-open path: "device settled below target" is
  // exactly the state the stall promotion accepts as terminal. Re-opening
  // would discard the carefully-frozen `metAtMs` / `finalProgress*` we
  // captured at the plateau and produce a noisy "satisfied → not satisfied"
  // oscillation against the idle classifier's exit hysteresis. Target-reached
  // mets keep the existing clear-on-drift behavior.
  if (
    record.satisfied
    && !isStallMetReason(record.metReason)
    && hasTrustworthyProgress(diag)
    && !diagnosticProgressAtTarget(diag)
  ) {
    return clearSatisfiedWithProgress(record, diag, nowMs, plan);
  }
  return recordObservedTick(record, diag, nowMs, plan);
};

const wasTargetReached = (record: InProgressRecord): boolean => {
  if (record.objectiveKind === 'temperature') {
    if (record.targetTemperatureC === null) return false;
    if (record.finalProgressC === null) return false;
    return record.finalProgressC >= record.targetTemperatureC;
  }
  if (record.targetPercent === null) return false;
  if (record.finalProgressPercent === null) return false;
  return record.finalProgressPercent >= record.targetPercent;
};

const classifyOutcome = (
  record: InProgressRecord,
  reason: 'deadline_passed' | 'replaced' | 'abandoned',
): DeferredObjectivePlanOutcome => {
  if (record.satisfied || wasTargetReached(record)) return 'met';
  if (reason === 'abandoned') return 'abandoned';
  if (reason === 'replaced') return 'replaced';
  if (record.finalProgressC === null && record.finalProgressPercent === null) return 'unknown';
  return 'missed';
};

const finalizeRecord = (
  record: InProgressRecord,
  nowMs: number,
  reason: 'deadline_passed' | 'replaced' | 'abandoned',
): DeferredObjectivePlanHistoryEntry => {
  const drainedSamples = drainProgressSamples(record.progressSamples);
  const outcome = classifyOutcome(record, reason);
  return {
    id: randomUUID(),
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    objectiveKind: record.objectiveKind,
    targetTemperatureC: record.targetTemperatureC,
    targetPercent: record.targetPercent,
    deadlineAtMs: record.deadlineAtMs,
    startedAtMs: record.startedAtMs,
    finalizedAtMs: nowMs,
    startProgressC: record.startProgressC,
    startProgressPercent: record.startProgressPercent,
    finalProgressC: record.finalProgressC,
    finalProgressPercent: record.finalProgressPercent,
    initialEnergyNeededKWh: record.initialEnergyNeededKWh,
    outcome,
    metAtMs: record.metAtMs,
    // Only persist `metReason` on `met` outcomes. The contract forbids it on
    // any other outcome (see `hasValidOutcome` in `planHistorySettings.ts`),
    // and a stalled record that finalizes as `replaced` / `abandoned` /
    // `unknown` should not carry a `met`-only field into history.
    ...(outcome === 'met' && record.metReason !== null ? { metReason: record.metReason } : {}),
    usedDeadlineReserve: record.usedDeadlineReserve,
    usedPolicyAvoid: record.usedPolicyAvoid,
    observedIntervals: record.observedIntervals.slice(),
    discoveredFrom: 'observation',
    originalPlan: record.originalPlan,
    finalPlan: record.finalPlan,
    // Persist `revisionCount` only when the recorder actually observed at least
    // one revision. Zero means "never plannable" — the UI treats that the same
    // as a missing field (no "replanned" copy) so suppressing it keeps existing
    // entries byte-stable and avoids zero-vs-undefined drift.
    ...(record.revisionCount > 0 ? { revisionCount: record.revisionCount } : {}),
    ...(drainedSamples.length > 0 ? { progressSamples: drainedSamples } : {}),
    // `deliveredKWh` + `totalCost` are persisted only when the runtime fed at
    // least one hourly delivery contribution — otherwise older entries
    // (where the hourly feed wasn't wired yet) and runs that never received
    // a contribution stay byte-stable across upgrades. The flag captures
    // "feed actually ran" so a legitimately zero-cost / zero-delivered run
    // still persists 0 rather than hiding the contribution.
    ...(record.hasDeliveryContribution
      ? { deliveredKWh: record.deliveredKWh, totalCost: record.totalCost }
      : {}),
    // Per-hour contributions are persisted only when at least one was
    // appended — runs that never received a contribution stay byte-stable
    // across upgrades, mirroring the `deliveredKWh` / `totalCost`
    // suppression contract above.
    ...(record.hourlyContributions.length > 0
      ? { hourlyContributions: record.hourlyContributions.slice() }
      : {}),
    ...(record.revisions.length > 0 ? { revisions: record.revisions.slice() } : {}),
  };
};

// Reads through the observer-layer idle classifier
// (`lib/observer/idleClassifier.ts`). `near_target_idle` and `capped_idle`
// both promote the run to satisfied (the run reflects "the device went as
// far as it was going to go" — same outcome, two underlying causes which
// the recorder distinguishes via `metReason`). `unresponsive` is a
// hardware-fault signal and is deliberately ignored — we don't want to
// silently call a tripped breaker "succeeded".
export type DeferredObjectiveStallClassificationReader = (
  deviceId: string,
) => 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined;

export type DeferredObjectiveBackfillConfig = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  deadlineAtMs: number;
  targetTemperatureC: number | null;
  targetPercent: number | null;
};

const synthesizeBackfillEntry = (
  config: DeferredObjectiveBackfillConfig,
): DeferredObjectivePlanHistoryEntry => ({
  id: randomUUID(),
  deviceId: config.deviceId,
  deviceName: config.deviceName,
  objectiveKind: config.objectiveKind,
  targetTemperatureC: config.targetTemperatureC,
  targetPercent: config.targetPercent,
  deadlineAtMs: config.deadlineAtMs,
  startedAtMs: config.deadlineAtMs,
  finalizedAtMs: config.deadlineAtMs,
  startProgressC: null,
  startProgressPercent: null,
  finalProgressC: null,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 0,
  outcome: 'unknown',
  metAtMs: null,
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [],
  discoveredFrom: 'backfill',
  originalPlan: null,
  finalPlan: null,
});

export type PlanHistoryPersistDeps = {
  // Persisted history reader. Returns null when no payload exists yet
  // (first install / settings purge). Migration from older schemas is done
  // upstream by `normalizeDeferredObjectivePlanHistory`, so the recorder
  // accepts the v4 envelope it was bumped to in v2.7.2.
  load: () => DeferredObjectivePlanHistoryV4 | null;
  // Persist the snapshot. Return `true` on success, `false` on failure (e.g. the underlying
  // settings.set threw and the host swallowed it). A `false` return keeps the recorder dirty
  // so a later flush retries, and lets callers gate side-effects (like advancing the
  // observation watermark) on real persistence success.
  save: (history: DeferredObjectivePlanHistoryV4) => boolean;
  // Optional bus the recorder publishes ended events to as runs finalize. The
  // recorder filters by `discoveredFrom === 'observation'` and public outcome
  // (`met`/`missed`/`abandoned`) before publishing — backfill entries and
  // `replaced`/`unknown` outcomes never reach the bus.
  endedBus?: DeferredObjectiveEndedBus;
  // Resolve the spot price and price tone (cheap/normal/expensive) for an
  // hour-aligned timestamp. The internal hour-rollover detector calls this
  // when it closes an hour so per-hour `hourlyContributions` carry a stable
  // band even if cheap/normal/expensive thresholds shift in a later
  // version. Returning `null` (no price data yet, hour outside the
  // published horizon) causes that hour's contribution to be skipped
  // rather than fabricated. The dep is optional so the recorder remains
  // useful in tests and for callers that drive `recordHourlyDelivery`
  // directly with their own pricing.
  resolveHourPrice?: HourPriceResolver;
  // Optional structured-debug emitter. The recorder emits one
  // `deferred_objective_history_finalized` event per observation entry as it
  // finalizes, carrying the resolved miss attribution (cause + the raw plan-time
  // confidence / committed-floor / delivery inputs it rested on). This is the
  // telemetry that lets us count how many `missed` runs were genuine capacity
  // misses versus shaky-estimate / conservative-planning false alarms. Optional
  // so the recorder stays usable in tests and headless callers. Gated on the
  // `deferred_objectives` debug topic by the wiring in `lib/app/appInit.ts`.
  debugStructured?: StructuredDebugEmitter;
};

// Per-hour delivery contribution fed into the recorder by the runtime
// power-tracker / pricing wiring. Both fields are absolute values for the
// hour: `deliveredKWh` is the device's measured useful kWh during that
// hour, `priceValue` is the hourly spot price in the user's display unit.
// The recorder sums `priceValue × deliveredKWh` into `totalCost` on the
// matching in-progress record. Wiring lives in `lib/app/appInit.ts`.
export type DeferredObjectivePlanHistoryHourlyDelivery = {
  deviceId: string;
  deadlineAtMs: number;
  // Hour-aligned start; redundantly carried so the recorder can ignore
  // contributions whose hour falls outside the run's observed window if a
  // late-arriving feed reports against a deadline that has already
  // finalized. Currently informational — duplicate contributions for the
  // same hour are added (the wiring is responsible for de-duping if needed).
  hourStartMs: number;
  deliveredKWh: number;
  priceValue: number;
  // Price-tier classification for the hour, resolved by the caller (the
  // runtime wiring) against the live cheap/normal/expensive thresholds.
  // Captured at contribution time so the postmortem reads a stable band
  // even if thresholds shift in a later version. See
  // `DeferredObjectivePlanHistoryHourlyTone`.
  tone: DeferredObjectivePlanHistoryHourlyTone;
};

export class DeferredObjectivePlanHistoryRecorder {
  private inProgress = new Map<InProgressKey, InProgressRecord>();

  private entries: DeferredObjectivePlanHistoryEntry[];

  private dirty = false;

  constructor(private readonly deps: PlanHistoryPersistDeps) {
    const loaded = deps.load();
    this.entries = loaded?.entries.slice() ?? [];
    this.trimEntries();
  }

  observe(
    diagnostics: readonly DeferredObjectiveDiagnostic[],
    nowMs: number,
    activePlans: DeferredObjectiveActivePlansV1 | null = null,
    getStallClassification?: DeferredObjectiveStallClassificationReader,
  ): void {
    const seenKeys = new Set<InProgressKey>();
    for (const diag of diagnostics) {
      if (diag.deadlineAtMs === null) continue;
      const key = buildKey(diag.deviceId, diag.deadlineAtMs);
      seenKeys.add(key);
      this.observeDiagnostic(diag, key, nowMs, activePlans, getStallClassification);
    }
    this.finalizeStaleRecords(seenKeys, nowMs);
  }

  // Runs after merge/start so the freeze-on-met-time logic in `mergeRecord`
  // doesn't overwrite the plateau on the cycle stall is declared.
  private maybePromoteOnStall(
    record: InProgressRecord,
    diag: DeferredObjectiveDiagnostic,
    nowMs: number,
    getStallClassification?: DeferredObjectiveStallClassificationReader,
  ): InProgressRecord {
    const classification = getStallClassification?.(diag.deviceId);
    const reason = stallClassificationToMetReason(classification);
    return reason === null
      ? record
      : promoteRecordToStalled(record, diag, nowMs, reason);
  }

  private observeDiagnostic(
    diag: DeferredObjectiveDiagnostic,
    key: InProgressKey,
    nowMs: number,
    activePlans: DeferredObjectiveActivePlansV1 | null,
    getStallClassification?: DeferredObjectiveStallClassificationReader,
  ): void {
    const plan = findPlanForRecord(activePlans, { deviceId: diag.deviceId, deadlineAtMs: diag.deadlineAtMs! });
    const existing = this.inProgress.get(key);
    if (existing) {
      const plannable = isPlannableStatus(diag.status) || isSatisfiedStatus(diag.status);
      // Plannable diagnostics roll forward progress + planning flags. Unknown/invalid still
      // count as observation ("PELS was watching"). If an already-met run later reports
      // trustworthy below-target progress, clear the live met marker; otherwise preserve
      // the last trustworthy progress.
      const merged = plannable
        ? mergeRecord(existing, diag, nowMs, plan)
        : recordNonPlannableTick(existing, diag, nowMs, plan);
      const withRollover = this.applyHourlyDeliveryRollover(merged, diag, nowMs);
      this.inProgress.set(
        key,
        this.maybePromoteOnStall(withRollover, diag, nowMs, getStallClassification),
      );
      return;
    }
    // Begin tracking on first sight of a future-dated deadline, regardless of status. The
    // deadline event is the recorded thing; observation quality is captured separately via
    // observedIntervals + progress nullability. The stale-deadline guard still applies so a
    // diagnostic whose deadline has already passed doesn't create a junk record finalized on
    // the same cycle.
    if (diag.deadlineAtMs! <= nowMs) return;
    const next = startRecord(diag, nowMs, plan);
    if (!next) return;
    // Deliberately skip stall promotion on first-seen records. The
    // classification ticks AFTER plan emission (`tickIdleClassifier`), so the
    // value we'd read here is the *previous* cycle's result — which belongs
    // to whatever objective ran for this device on the prior tick. After a
    // `finalizeForUserChange` swap (user replaced target / deadline), that
    // stale `near_target_idle` would falsely auto-complete the brand-new run
    // on its first tick and stick until finalization. The next tick — where
    // the classifier has had a chance to re-evaluate against the actual
    // current objective — handles promotion through the `existing` branch.
    this.inProgress.set(key, next);
  }

  /**
   * Synthesize history entries for one-shot deadlines that elapsed while no plannable
   * observation was possible (e.g. PELS was off, or the diagnostic stream never produced an
   * entry for this objective). Each config carries a single absolute `deadlineAtMs`; we
   * include it only when it lies in the (fromMs, toMs] window and no entry already records
   * the same `(deviceId, deadlineAtMs)` key.
   */
  backfillFromConfig(
    configs: readonly DeferredObjectiveBackfillConfig[],
    fromMs: number,
    toMs: number,
  ): void {
    if (configs.length === 0 || toMs <= fromMs) return;
    const existingKeys = new Set<InProgressKey>(
      this.entries.map((entry) => buildKey(entry.deviceId, entry.deadlineAtMs)),
    );
    for (const config of configs) {
      if (config.deadlineAtMs <= fromMs || config.deadlineAtMs > toMs) continue;
      const key = buildKey(config.deviceId, config.deadlineAtMs);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      this.pushEntry(synthesizeBackfillEntry(config));
    }
  }

  /**
   * Finalize any in-progress run for this device because the user changed or cleared the
   * objective. `'replaced'` is for a new deadline / target replacing the prior one;
   * `'abandoned'` is for an explicit clear. Without this signal the recorder would wait the
   * full `ABANDON_GRACE_MS` before declaring the run abandoned, and a user-initiated swap
   * would be misreported as `'abandoned'` instead of `'replaced'`.
   *
   * The active-plan recorder deliberately keeps same-deadline target changes as in-run
   * revisions; history splits them into separate entries so each entry has a stable target
   * to judge outcome against.
   */
  finalizeForUserChange(deviceId: string, nowMs: number, reason: 'replaced' | 'abandoned'): void {
    for (const [key, record] of this.inProgress) {
      if (record.deviceId !== deviceId) continue;
      const flushed = this.flushOpenHourAtFinalize(record);
      this.pushEntry(finalizeRecord(flushed, nowMs, reason));
      this.inProgress.delete(key);
    }
  }

  /**
   * Sum a per-hour delivery contribution onto the in-progress run that
   * matches `(deviceId, deadlineAtMs)`. The matching record's running
   * `deliveredKWh` and `totalCost = Σ priceValue × deliveredKWh` totals are
   * persisted at finalization. No-op when no matching in-progress run
   * exists (late contribution after the deadline finalized, or contribution
   * for a deadline this recorder never tracked).
   *
   * Designed as a one-shot push rather than per-cycle bookkeeping so the
   * caller can drive it from either the power-tracker hourly rollover or
   * from a plan-cycle aggregator without the recorder needing to know
   * either data source's cadence. Negative `deliveredKWh` values are
   * dropped (defensive: only consumption is interesting; production / sign
   * inversions would corrupt the running total).
   */
  recordHourlyDelivery(contribution: DeferredObjectivePlanHistoryHourlyDelivery): void {
    if (!Number.isFinite(contribution.deliveredKWh) || contribution.deliveredKWh < 0) return;
    if (!Number.isFinite(contribution.priceValue)) return;
    const key = buildKey(contribution.deviceId, contribution.deadlineAtMs);
    const record = this.inProgress.get(key);
    if (!record) return;
    // Hour-align the timestamp the postmortem renders against so duplicate
    // contributions for the same hour land on the same bucket (the strip
    // sums kWh into the existing entry and keeps the latest tone/price).
    // Floor against the contribution's `hourStartMs` rather than `nowMs`
    // because the caller may replay a missed hour from an aggregator
    // cadence that doesn't match real time.
    const hourAtMs = hourBucketMs(contribution.hourStartMs);
    const hourlyContributions = appendHourlyContribution(record.hourlyContributions, {
      atMs: hourAtMs,
      deliveredKWh: contribution.deliveredKWh,
      priceValue: contribution.priceValue,
      tone: contribution.tone,
    });
    this.inProgress.set(key, {
      ...record,
      deliveredKWh: record.deliveredKWh + contribution.deliveredKWh,
      totalCost: record.totalCost + contribution.priceValue * contribution.deliveredKWh,
      hasDeliveryContribution: true,
      hourlyContributions,
    });
  }

  // Drive the internal hour-rollover detector after a cycle's progress
  // sample has been recorded. Each closed-hour contribution is folded into
  // the record exactly the same way `recordHourlyDelivery` does — sharing
  // the merge helper guarantees the postmortem totals stay consistent
  // whether the contribution arrived from this runtime wiring or from an
  // external aggregator. The `currentHourOpening` anchor and cached
  // `lastKWhPerUnit` are always refreshed so the next cycle's rollover sees
  // the freshest values, even on cycles that produced no contribution.
  private applyHourlyDeliveryRollover(
    record: InProgressRecord,
    diag: DeferredObjectiveDiagnostic,
    nowMs: number,
  ): InProgressRecord {
    if (!hasTrustworthyProgress(diag)) return record;
    const nowProgress = diag.objectiveKind === 'temperature'
      ? diag.currentTemperatureC
      : diag.currentPercent;
    if (nowProgress === null) return record;
    const kWhPerUnit = pickKwhPerUnit(diag);
    // Anchor an opening on the first trustworthy reading even when
    // kWh/unit isn't resolved yet — once a profile lands later in the run
    // we can still attribute the closing hour using the freshly-resolved
    // factor. Skip emission for the prior hour if kWh/unit was missing
    // when it closed.
    if (record.currentHourOpening === null) {
      return {
        ...record,
        currentHourOpening: { hourMs: hourBucketMs(nowMs), value: nowProgress },
        lastKWhPerUnit: kWhPerUnit ?? record.lastKWhPerUnit,
      };
    }
    if (kWhPerUnit === null) {
      // No factor yet — keep the existing opening so the eventual
      // resolution can still attribute against it, but skip emission.
      return { ...record, lastKWhPerUnit: kWhPerUnit ?? record.lastKWhPerUnit };
    }
    const rollover = detectHourRollover({
      opening: record.currentHourOpening,
      nowProgress,
      nowMs,
      kWhPerUnit,
      resolvePrice: this.deps.resolveHourPrice,
    });
    if (rollover === null) {
      // No transition — only refresh the cached kWh/unit so finalize-time
      // flush uses the latest factor.
      return { ...record, lastKWhPerUnit: kWhPerUnit };
    }
    return this.foldContributionsIntoRecord({
      record,
      contributions: rollover.contributions,
      nextOpening: rollover.nextOpening,
      kWhPerUnit,
    });
  }

  // Pure merge of zero-or-more emitted contributions into an in-progress
  // record. Mirrors the totals math in `recordHourlyDelivery` so external
  // aggregator pushes and the internal rollover path agree byte-for-byte
  // on the persisted entry. Always advances `currentHourOpening` and
  // `lastKWhPerUnit` so finalize-time flushing has the right anchor even
  // when no contribution fired this cycle.
  private foldContributionsIntoRecord(params: {
    record: InProgressRecord;
    contributions: readonly DeferredObjectivePlanHistoryHourlyContribution[];
    nextOpening: HourProgressSnapshot;
    kWhPerUnit: number;
  }): InProgressRecord {
    const { record, contributions, nextOpening, kWhPerUnit } = params;
    if (contributions.length === 0) {
      return { ...record, currentHourOpening: nextOpening, lastKWhPerUnit: kWhPerUnit };
    }
    let { hourlyContributions, deliveredKWh, totalCost } = record;
    for (const contribution of contributions) {
      hourlyContributions = appendHourlyContribution(hourlyContributions, contribution);
      deliveredKWh += contribution.deliveredKWh;
      totalCost += contribution.deliveredKWh * contribution.priceValue;
    }
    return {
      ...record,
      hourlyContributions,
      deliveredKWh,
      totalCost,
      hasDeliveryContribution: true,
      currentHourOpening: nextOpening,
      lastKWhPerUnit: kWhPerUnit,
    };
  }

  // Flush a final contribution for the still-open hour when the run
  // finalizes. Without this, a sub-hour run (short EV top-up, brief
  // thermal nudge) that never crossed an hour boundary would record
  // `hasDeliveryContribution: false` and drop its delivery entirely. The
  // helper returns the record updated with the flushed contribution (or
  // the original record if no flush was possible — no opening anchor, no
  // measurable delta, no kWh/unit, or no price resolver).
  private flushOpenHourAtFinalize(record: InProgressRecord): InProgressRecord {
    const finalProgress = record.objectiveKind === 'temperature'
      ? record.finalProgressC
      : record.finalProgressPercent;
    // Option (a): advance the opening anchor to the *next* hour bucket so a
    // (defensive) re-entry on the returned record cannot collide with the
    // just-flushed hour. Finalization deletes the record immediately today, so
    // this is belt-and-braces — but the previous shape (re-using the
    // just-closed `hourMs`) was a latent double-count waiting for a refactor.
    // See `buildFinalHourFlush` for the next-bucket math.
    const flush = buildFinalHourFlush({
      opening: record.currentHourOpening,
      finalProgress,
      kWhPerUnit: record.lastKWhPerUnit,
      resolvePrice: this.deps.resolveHourPrice,
    });
    if (flush === null) return record;
    return this.foldContributionsIntoRecord({
      record,
      contributions: [flush.contribution],
      nextOpening: flush.nextOpening,
      kWhPerUnit: record.lastKWhPerUnit!,
    });
  }

  private finalizeStaleRecords(seenKeys: ReadonlySet<InProgressKey>, nowMs: number): void {
    for (const [key, record] of this.inProgress) {
      if (record.deadlineAtMs <= nowMs) {
        const flushed = this.flushOpenHourAtFinalize(record);
        this.pushEntry(finalizeRecord(flushed, nowMs, 'deadline_passed'));
        this.inProgress.delete(key);
        continue;
      }
      if (seenKeys.has(key)) continue;
      // Diagnostic stopped appearing while deadline is still future. Wait for the grace
      // window before declaring the run abandoned, in case the device briefly drops out and
      // recovers.
      if (nowMs - lastObservedAtMs(record) >= ABANDON_GRACE_MS) {
        const flushed = this.flushOpenHourAtFinalize(record);
        this.pushEntry(finalizeRecord(flushed, nowMs, 'abandoned'));
        this.inProgress.delete(key);
      }
    }
  }

  private pushEntry(entry: DeferredObjectivePlanHistoryEntry): void {
    this.entries.push(entry);
    this.trimEntries();
    this.dirty = true;
    this.emitFinalizedAttribution(entry);
    const endedEvent = buildEndedEventFromEntry(entry);
    if (endedEvent !== null) {
      this.deps.endedBus?.publish(endedEvent);
    }
  }

  // Emit the per-run miss attribution as the entry finalizes. Backfill entries
  // are skipped: they carry no observed plan/delivery, so the attribution would
  // be `unknown` with null inputs — noise. Emitting on every outcome (not just
  // `missed`) is deliberate: the met/missed ratio against the same confidence /
  // floor inputs is what quantifies the false-alarm rate.
  private emitFinalizedAttribution(entry: DeferredObjectivePlanHistoryEntry): void {
    if (!this.deps.debugStructured) return;
    if (entry.discoveredFrom !== 'observation') return;
    this.deps.debugStructured(buildFinalizedAttributionEvent(entry));
  }

  private trimEntries(): void {
    this.entries.sort((a, b) => a.finalizedAtMs - b.finalizedAtMs);
    if (this.entries.length > HISTORY_ENTRY_CAP) {
      this.entries = this.entries.slice(this.entries.length - HISTORY_ENTRY_CAP);
    }
  }

  flushIfDirty(): boolean {
    if (!this.dirty) return false;
    const persisted = this.deps.save({
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: this.entries.slice(),
    });
    if (!persisted) return false;
    this.dirty = false;
    return true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getHistorySnapshot(): DeferredObjectivePlanHistoryV4 {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: this.entries.slice(),
    };
  }

  // Test-only seam: clear in-progress state without touching persisted entries.
  resetInProgressForTests(): void {
    this.inProgress.clear();
  }
}
