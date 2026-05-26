import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryHourlyContribution,
  DeferredObjectivePlanHistoryObservedInterval,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  DeferredObjectivePlanMetReason,
  DeferredObjectivePlanOutcome,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import {
  appendRevisionLogIfNew,
  attachEnergyExpectedKWh,
  captureRevisionSnapshot,
  drainProgressSamples,
  hasTrustworthyProgress,
  hourBucketMs,
  type HourProgressSnapshot,
  pickEnergyExpectedKWhFromPlan,
  pickKwhPerUnit,
  recordProgressSample,
  seedProgressSamples,
} from './planHistoryV4Helpers';
import { randomUUID } from 'node:crypto';

type ObservedInterval = DeferredObjectivePlanHistoryObservedInterval;

export type InProgressKey = string; // `${deviceId}|${deadlineAtMs}`

// Two consecutive observations closer than this are merged into one observed interval. A larger
// gap leaves a hole the UI can surface as "we weren't watching during that span." Picked to
// absorb normal rebuild jitter (a few seconds to a couple of minutes) without hiding genuine
// downtime windows.
const INTERVAL_MERGE_GAP_MS = 5 * 60 * 1000;

export type InProgressRecord = Omit<
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
  // delta (opening → first reading in the *next* hour) is converted to
  // delivered kWh using `lastKWhPerUnit` and attributed to `opening.hourMs`
  // (the just-closed hour) as a contribution. See `detectHourRollover` in
  // `planHistoryV4Helpers.ts` for the attribution contract.
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
  // — `finalizeStaleRecords`, `finalizeForUserChange`, `finalizeElapsedDeadline`
  // — do not carry one).
  // `null` when no diagnostic ever resolved a profile. Same lossy-restart
  // contract as `currentHourOpening` — see above.
  lastKWhPerUnit: number | null;
  // Mean-based plan total (no variance buffer) from the most recent
  // observed revision (`revision.energyExpectedKWh`). Cached on the record so
  // miss attribution at finalize time can compare delivered energy against the
  // mean rather than the buffered `plannedKWh` sum — a cold-start run with a
  // wide `k·SE` buffer would otherwise be misclassified as `capacity_shortfall`
  // when it delivered the mean estimate. `null` when no revision has been
  // observed or when the revision didn't carry `energyExpectedKWh` (steady
  // device — buffer equals mean, so the buffered comparison is already
  // correct). Runtime-only as an in-flight tracking field — the same
  // lossy-restart contract as `currentHourOpening` applies — but `finalizeRecord`
  // promotes it to the persisted snapshot's `energyExpectedKWh` so the UI render
  // path resolves the same `missCause` the runtime structured log emits (see
  // `attachEnergyExpectedKWh`).
  energyExpectedKWhAtFinalize: number | null;
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

export const findPlanForRecord = (
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

export const buildKey = (deviceId: string, deadlineAtMs: number): InProgressKey => (
  `${deviceId}|${deadlineAtMs}`
);

export const isPlannableStatus = (status: DeferredObjectiveDiagnostic['status']): boolean => (
  status !== 'unknown' && status !== 'invalid'
);

export const isSatisfiedStatus = (status: DeferredObjectiveDiagnostic['status']): boolean => (
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

export const lastObservedAtMs = (record: InProgressRecord): number => {
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

export const startRecord = (
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
    energyExpectedKWhAtFinalize: pickEnergyExpectedKWhFromPlan(plan),
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
) => {
  const finalRevision = pickRevisionForFinal(plan);
  // Revision count is monotonic. Track the highest index ever observed so a
  // transient `plan` regression (planner cleared `latest` after a settings
  // glitch, mid-run pickup) does not reset the count we hand to history.
  const nextRevisionCount = Math.max(record.revisionCount, resolveRevisionCount(plan));
  // Mean-based plan total cached on the record for miss attribution at
  // finalize. Sticky across observations that drop the field (steady devices
  // where the recorder omits `energyExpectedKWh` once it equals the buffered
  // total) so a cold-start run that later steadies still attributes against
  // the original cold-start mean.
  const energyExpectedKWhAtFinalize
    = pickEnergyExpectedKWhFromPlan(plan) ?? record.energyExpectedKWhAtFinalize;
  if (!finalRevision) {
    const { originalPlan, finalPlan, revisions } = record;
    return { originalPlan, finalPlan, revisionCount: nextRevisionCount, revisions, energyExpectedKWhAtFinalize };
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
    energyExpectedKWhAtFinalize,
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

export const mergeRecord = (
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
export const promoteRecordToStalled = (
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
export const stallClassificationToMetReason = (
  classification: 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined,
): DeferredObjectivePlanMetReason | null => {
  if (classification === 'near_target_idle') return 'stalled';
  if (classification === 'capped_idle') return 'stalled_device_capped';
  return null;
};

export const recordNonPlannableTick = (
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

export const finalizeRecord = (
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
    originalPlan: attachEnergyExpectedKWh(record.originalPlan, record.energyExpectedKWhAtFinalize),
    finalPlan: attachEnergyExpectedKWh(record.finalPlan, record.energyExpectedKWhAtFinalize),
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
