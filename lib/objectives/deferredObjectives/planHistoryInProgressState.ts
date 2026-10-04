import { EMPTY_DELIVERY_EVIDENCE } from './deliveryEvidence';
import type { TaskDeliveryEvidence } from '../../../packages/contracts/src/taskDelivery';
import { resolvedTrajectoryStatus } from './diagnosticTypes';
import type { MeteredRunCommitment } from './planHistoryMeteredState';
import type { TaskEvaluation } from './taskEvaluation';
import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryCostDisplay,
  DeferredObjectivePlanHistoryHourStartBooking,
  DeferredObjectivePlanHistoryHourlyContribution,
  DeferredObjectivePlanHistoryObservedInterval,
  DeferredObjectivePlanHistoryRecord,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  DeferredObjectivePlanMetReason,
  DeferredObjectivePlanTerminalOutcome,
  ResolvedDeferredObjectivePlanHistoryEntry,
  ResolvedDeferredObjectivePlanHistoryProgressSample,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { DeferredObjectiveSettingsKind } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { ObjectiveProgressDirectionRead } from '../../objectives/types';
import {
  appendRevisionLogIfNew,
  captureRevisionSnapshot,
  drainProgressSamples,
  recordProgressSample,
  seedProgressSamples,
} from './planHistoryV4Helpers';
import { resolveRemainingEnergyKWh } from '../../../packages/shared-domain/src/energyQuantities';
import { randomUUID } from 'node:crypto';

type ObservedInterval = DeferredObjectivePlanHistoryObservedInterval;

// A run learns its original requirement only from a point where nothing has
// been delivered (`backfillCommitment`). Restored known and unknown
// requirements stay as saved: a later estimate is not the original. A run saved
// while still learning resumes as `resumed_learning`, carrying the trusted
// start progress it had before the restart, because a restart adds a second
// way to have moved unseen (`resumeSavedCommitment` in `planHistoryMeteredRun.ts`).
export type InProgressCommitment =
  | Exclude<MeteredRunCommitment, { kind: 'learning' }>
  | { kind: 'learning' }
  | { kind: 'resumed_learning'; startProgressValue: number };

export type InProgressKey = string; // `${deviceId}|${deadlineAtMs}`

// Two consecutive observations closer than this are merged into one observed interval. A larger
// gap leaves a hole the UI can surface as "we weren't watching during that span." Picked to
// absorb normal rebuild jitter (a few seconds to a couple of minutes) without hiding genuine
// downtime windows.
const INTERVAL_MERGE_GAP_MS = 5 * 60 * 1000;

// Readings are held in the task's own unit, one value each (`targetValue`,
// `startProgressValue`, `finalProgressValue`, sample `value`), as the stored
// row keeps them; `objectiveKind` names the unit.
export type InProgressRecord = Omit<
  DeferredObjectivePlanHistoryRecord,
  'id'
  | 'deliveryExplanation'
  | 'finalizedAtMs'
  | 'outcome'
  | 'discoveredFrom'
  | 'originalPlan'
  | 'finalPlan'
  | 'revisionCount'
  | 'progressSamples'
  | 'deliveredKWh'
  | 'totalCost'
  | 'costDisplay'
  | 'revisions'
  | 'hourlyContributions'
  | 'hourStartBookings'
  | 'metReason'
  | 'initialEnergyExpectedKWh'
  | 'progressDirection'
  | 'targetValue'
> & {
  // The stored row takes both from the device at the API boundary; the
  // recorder has them from the diagnostic.
  deviceName: string | null;
  objectiveKind: DeferredObjectiveSettingsKind;
  targetValue: number;
  deliveryEvidence: TaskDeliveryEvidence;
  commitment: InProgressCommitment;
  // Direction paired with `finalProgressValue`; persisted as the finalized
  // row's `progressDirection`.
  finalProgressDirection: ObjectiveProgressDirectionRead;
  satisfied: boolean;
  // `null` for target-reached / in-flight; `'stalled'` once the idle
  // classifier promoted the run. Retained while completion remains accepted.
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
  // 15-minute downsample of progress observations, keyed by quarter-hour-
  // aligned bucket start (`progressSampleBucketMs`). Each cycle upserts the
  // latest reading for the current bucket; runs long enough to exceed
  // `PROGRESS_SAMPLES_PER_ENTRY_CAP` are re-bucketed onto a coarser grid
  // (deterministic eviction, full-run coverage preserved) so the in-memory
  // map stays bounded. Drained into the entry at finalization.
  progressSamples: Map<number, ResolvedDeferredObjectivePlanHistoryProgressSample>;
  // Total kWh delivered to the device across the run, integrated from its
  // trusted measured-power feed. Persisted after the first metered sample,
  // including an exact zero-delivery run.
  deliveredKWh: number;
  // Σ priceValue × deliveredKWh across the run, in the price scheme's raw
  // minor unit at record time (øre for the default Norwegian scheme).
  // Tracked alongside `deliveredKWh` so the persisted ratio
  // (cost / delivered) stays internally consistent.
  totalCost: number;
  // Price-display provenance (`{ unit, divisor }`) the `totalCost` above is
  // being accumulated under, captured the first time a priced metered interval
  // is integrated from the hour-price resolver's
  // `costDisplay`. `null` until the first priced contribution. Persisted at
  // finalize so the archive formats the figure in its recorded currency; a run
  // that never received a priced contribution finalizes with it null (and the
  // entry omits the field, falling back to the recording-era øre/kr default).
  // See `DeferredObjectivePlanHistoryRecord.costDisplay`.
  costDisplay: DeferredObjectivePlanHistoryCostDisplay | null;
  // Becomes true on the first delivery contribution so
  // `deliveredKWh` and `totalCost` are persisted (as `0` if needed) rather
  // than dropped. Without this flag a run with one zero-priced delivered
  // hour would look identical to a run that never received a contribution.
  hasDeliveryContribution: boolean;
  // True until a positive metered interval cannot be paired with a price.
  // Delivery remains authoritative either way; this only decides whether the
  // accumulated cost is complete enough to persist.
  deliveryPriceComplete: boolean;
  // Chronological per-revision metadata appended each time the active plan's
  // `latest.revision` index increases. Bounded implicitly by the active-plan
  // recorder's per-cycle dedupe — `prices_revised` and `rate_refined` only
  // fire when the underlying inputs actually changed, so realistic runs see
  // ~5-10 entries at most. No explicit cap; adding one is only worth doing if a
  // pathological replan loop ever surfaces.
  revisions: DeferredObjectivePlanHistoryRevisionLogEntry[];
  // Per-hour metered delivery contributions. Each entry mirrors one
  // contribution: hour-aligned `atMs`, delivered kWh, the
  // spot-price the recorder summed into `totalCost`, and the price tone the
  // hour-price resolver returned. The postmortem bar strip
  // (`DeadlinePlanHistoryDetail`) reads this list to render one bar per
  // hour. Persisted only when at least one contribution was recorded —
  // empty runs stay byte-stable across upgrades, gated by
  // `hasDeliveryContribution` the same way `deliveredKWh` / `totalCost`
  // are.
  hourlyContributions: DeferredObjectivePlanHistoryHourlyContribution[];
  // One entry per hour whose start the run saw, in hour order, captured by
  // `captureHourStartBooking` (`planHistoryHourStartBookings.ts`) and never
  // revised. Includes hours the plan in force booked nothing for, so a restart
  // inside such an hour cannot book it afterwards from a plan revised mid-hour.
  // Persisted with the metered state.
  hourStartBookings: DeferredObjectivePlanHistoryHourStartBooking[];
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

export const isPlannableStatus = (
  status: ReturnType<typeof resolvedTrajectoryStatus>,
): boolean => status !== undefined && status !== 'invalid';

export const isSatisfiedStatus = (
  status: ReturnType<typeof resolvedTrajectoryStatus>,
): boolean => status === 'satisfied';

// Operational planning and completion determine which history update applies.
export const rawHorizonStatus = (
  diag: DeferredObjectiveDiagnostic,
): ReturnType<typeof resolvedTrajectoryStatus> => {
  const { evaluation } = diag;
  if (evaluation.planning.kind === 'allocated') return evaluation.planning.plan.status;
  if (evaluation.completion.kind === 'target_reached'
    || evaluation.completion.kind === 'accepted_near_target') return 'satisfied';
  return undefined;
};

const usesDeadlineReserve = (diag: DeferredObjectiveDiagnostic): boolean => (
  diag.evaluation.planning.kind === 'allocated' && diag.evaluation.planning.plan.usesDeadlineReserve
);

// The producer's known progress is the sole history reading source.
const captureTrustedProgress = (diag: DeferredObjectiveDiagnostic): number | null => (
  diag.evaluation.progress.kind === 'known' ? diag.evaluation.progress.value : null
);

const captureTrustedDirection = (
  diag: DeferredObjectiveDiagnostic,
  fallback: InProgressRecord['finalProgressDirection'],
): InProgressRecord['finalProgressDirection'] => diag.evaluation.progress.kind === 'known'
  ? diag.evaluation.progress.direction
  : fallback;

export const lastObservedAtMs = (record: InProgressRecord): number => {
  const { observedIntervals } = record;
  const last = observedIntervals.at(-1);
  if (last === undefined) return record.startedAtMs;
  return last.toMs;
};

const extendIntervals = (
  intervals: readonly ObservedInterval[],
  nowMs: number,
): ObservedInterval[] => {
  const last = intervals.at(-1);
  if (last === undefined) return [{ fromMs: nowMs, toMs: nowMs }];
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

// One reading of "what does this run need?", shared by the initial seed and the
// per-cycle backfill so the two cannot drift. Absence stays absent rather than
// becoming a fabricated zero.
const resolveCommitment = (diag: DeferredObjectiveDiagnostic): InProgressCommitment => {
  const kwh = resolveRemainingEnergyKWh({
    energyExpectedKWh: diag.energyExpectedKWh ?? undefined,
    energyNeededKWh: diag.energyNeededKWh ?? 0,
  });
  return kwh === null ? { kind: 'learning' } : { kind: 'known', kwh };
};

export const startRecord = (
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord | null => {
  if (diag.deadlineAtMs === null) return null;
  const currentlySatisfied = diag.evaluation.completion.kind === 'target_reached';
  const originalRevision = pickRevisionForOriginal(plan);
  const finalRevision = pickRevisionForFinal(plan);
  const originalSnapshot = originalRevision ? captureRevisionSnapshot(originalRevision, plan) : null;
  const finalSnapshot = finalRevision ? captureRevisionSnapshot(finalRevision, plan) : null;
  return {
    deviceId: diag.deviceId,
    deviceName: diag.deviceName ?? null,
    objectiveKind: diag.objectiveKind,
    finalProgressDirection: captureTrustedDirection(diag, 'unknown'),
    targetValue: diag.evaluation.requestedTarget,
    deadlineAtMs: diag.deadlineAtMs,
    startedAtMs: nowMs,
    startProgressValue: captureTrustedProgress(diag),
    finalProgressValue: captureTrustedProgress(diag),
    initialEnergyNeededKWh: diag.energyNeededKWh ?? 0,
    // Seeded here when the producer can already state it; otherwise filled by
    // `backfillCommitment` on the first cycle that can. Never read back off a
    // revision snapshot — `originalPlan` is the richest schedule the planner
    // ever achieved (freely replaced mid-run) and every revision's own figure
    // is a shrinking remainder.
    commitment: resolveCommitment(diag),
    metAtMs: currentlySatisfied ? nowMs : null,
    usedDeadlineReserve: usesDeadlineReserve(diag),
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
    deliveryEvidence: EMPTY_DELIVERY_EVIDENCE,
    deliveredKWh: 0,
    totalCost: 0,
    costDisplay: null,
    hasDeliveryContribution: false,
    deliveryPriceComplete: true,
    revisions: [],
    hourlyContributions: [],
    hourStartBookings: [],
  };
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
  if (!finalRevision) {
    const { originalPlan, finalPlan, revisions } = record;
    return { originalPlan, finalPlan, revisionCount: nextRevisionCount, revisions };
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


// Back-fill `startProgressValue` from the first cycle that actually carries a
// fresh reading. `startRecord` stamps it from the first diagnostic the
// recorder sees, but Homey SDK reads can
// transiently fail (per `feedback_homey_sdk_unreliable` — see
// `notes/smart-task-ui/README.md` for the live-walk regression), so a run
// that starts with `currentValue: null` would otherwise carry that null all
// the way to finalization. The history
// formatter (`packages/shared-domain/src/deferredPlanHistory.ts`) returns
// `null` for the progress line when the start value is null, hiding the
// run from the past-tasks list. Adopting the first *trustworthy* reading
// (`captureTrustedProgress`, not a stale/invalid one) keeps "start"
// semantically meaning "first trustworthy observed progress" rather than
// "snapshot at create-time, even if it was missing or stale". Once set, the
// value is sticky — later cycles must not overwrite it.
const backfillStartProgress = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
): number | null => record.startProgressValue ?? captureTrustedProgress(diag);

// The run's committed mean requirement, filled on the FIRST cycle the producer
// can state it and frozen thereafter.
//
// Not captured only at `startRecord`, because the record is created on first
// sight of a future deadline "regardless of status" — which routinely lands
// inside the learning window, before any profile has resolved
// (`objective_missing_capacity`, surfaced as "Learning energy use"). Asking once
// at the start and never again would leave the commitment unset for a run that
// resolved a requirement seconds later. A smart-task device must have measured
// power to be valid, so it produces credible samples, learns a rate, and
// resolves a requirement — the question is only when, not whether.
//
// Only learning runs, including one resumed after a restart, can capture a
// requirement; known and unknown values stay fixed. The first answer wins: this
// is the energy the run set out to need, not a later remainder.
//
// Gated on no positive energy having been delivered yet, and that gate is
// load-bearing. A trusted 0 kW interval is still an exact delivery observation,
// but it does not turn a later resolved requirement into a remainder.
// `resolveCommitment` reads `remainingUnits` as of the cycle it is asked, so
// once the device has already made progress the answer is a REMAINDER, not the
// run's total requirement — while `deliveredKWh` keeps accumulating from the
// run's start. The commitment's readers set the two side by side: the
// budget-damage sizing prices a budget-caused miss as committed minus delivered
// (`lib/weather/deadlineMissBudgetDay.ts`), and the Missed shortfall chip reads
// "Delivered X of Y kWh". A remainder would understate both.
//
// So the commitment is only stated from a point where nothing has been
// delivered. A run that was still learning when delivery began keeps no
// commitment, and its readers decline rather than substitute another figure.
//
// A restart adds a second way to have moved unseen: energy delivered while
// PELS was down is never metered, so a run resumed while learning
// (`resumed_learning`) passes `hasMovedSinceResumedStart` as well. The
// zero-delivery gate above still covers what was metered on both sides of the
// restart, since the restored delivery is summed into `deliveredKWh`.
const backfillCommitment = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
): InProgressCommitment => {
  const { commitment } = record;
  if (commitment.kind === 'known' || commitment.kind === 'unknown') return commitment;
  if (record.deliveredKWh > 0) return { kind: 'unknown' };
  if (commitment.kind === 'resumed_learning') {
    const { progress } = diag.evaluation;
    // For the type only: this runs on plannable or satisfied ticks, and the
    // producer allocates a plan or accepts completion only from known progress
    // (`buildAllocatedTaskEvaluation`, `completionFromDiagnostic`).
    if (progress.kind !== 'known') return commitment;
    if (hasMovedSinceResumedStart(commitment.startProgressValue, record.objectiveKind, progress)) {
      return { kind: 'unknown' };
    }
  }
  const resolved = resolveCommitment(diag);
  // Still unresolved: keep the learning state, including its restart gate.
  return resolved.kind === 'known' ? resolved : commitment;
};

// How far a resumed run's progress may move toward its target before a
// requirement stated after the restart could be a remainder: a single sensor
// tick is not progress. Owned here, by the restart gate.
const RESTART_PROGRESS_DEADBAND: Record<DeferredObjectiveSettingsKind, number> = {
  temperature: 0.5,
  ev_soc: 1,
  energy: 0.1,
};

// Has a run resumed while learning made progress since it started? Compares
// the start progress saved before the restart with this cycle's trusted
// reading. "Moved" is progress in the task's direction of at least the
// per-kind deadband. A reading that fell back (a tank cooling while PELS was
// down) is not progress, and the requirement read from it is no smaller than
// the one the run started with. Known progress always carries its direction.
const hasMovedSinceResumedStart = (
  startProgressValue: number,
  kind: DeferredObjectiveSettingsKind,
  progress: Extract<TaskEvaluation['progress'], { kind: 'known' }>,
): boolean => {
  const change = progress.value - startProgressValue;
  const towardTarget = progress.direction === 'increasing' ? change : -change;
  return towardTarget >= RESTART_PROGRESS_DEADBAND[kind];
};


// The live completion owner retains near-target acceptance while the observer's
// hysteresis evidence holds. A trusted exit reopens the run; unavailable progress
// preserves the last accepted result until the owner can decide again.
const computeMergedMetState = (
  record: InProgressRecord,
  evaluation: TaskEvaluation,
  nowMs: number,
): {
  satisfied: boolean;
  metAtMs: number | null;
  metReason: DeferredObjectivePlanMetReason | null;
  finalProgressValue: number | null;
  finalProgressDirection: InProgressRecord['finalProgressDirection'];
} => {
  const acceptedNearTarget = evaluation.completion.kind === 'accepted_near_target';
  const preserveAccepted = record.satisfied && evaluation.completion.kind === 'inactive';
  const currentlySatisfied = acceptedNearTarget || preserveAccepted
    || evaluation.completion.kind === 'target_reached';
  const preservedMetReason = preserveAccepted ? record.metReason : null;
  const preservePlateau = acceptedNearTarget && record.satisfied;
  const currentValue = evaluation.progress.kind === 'known' ? evaluation.progress.value : record.finalProgressValue;
  const currentDirection = evaluation.progress.kind === 'known'
    ? evaluation.progress.direction : record.finalProgressDirection;
  return {
    satisfied: currentlySatisfied,
    metAtMs: currentlySatisfied ? (record.metAtMs ?? nowMs) : null,
    metReason: acceptedNearTarget ? 'stalled' : preservedMetReason,
    finalProgressValue: preservePlateau ? record.finalProgressValue : currentValue,
    finalProgressDirection: preservePlateau ? record.finalProgressDirection : currentDirection,
  };
};

export const mergeRecord = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord => {
  const merged = computeMergedMetState(record, diag.evaluation, nowMs);
  return {
    ...record,
    deviceName: diag.deviceName ?? record.deviceName,
    startProgressValue: backfillStartProgress(record, diag),
    commitment: backfillCommitment(record, diag),
    finalProgressValue: merged.finalProgressValue,
    finalProgressDirection: merged.finalProgressDirection,
    usedDeadlineReserve: record.usedDeadlineReserve || usesDeadlineReserve(diag),
    observedIntervals: extendIntervals(record.observedIntervals, nowMs),
    satisfied: merged.satisfied,
    metAtMs: merged.metAtMs,
    metReason: merged.metReason,
    progressSamples: recordProgressSample(record.progressSamples, diag.evaluation, nowMs),
    ...refreshPlanSnapshots(record, plan),
  };
};

/** Apply a current completion read without fabricating a plan revision. */
export const refreshRecordCompletion = (
  record: InProgressRecord,
  evaluation: TaskEvaluation,
  nowMs: number,
): InProgressRecord => ({
  ...record,
  ...computeMergedMetState(record, evaluation, nowMs),
  startProgressValue: record.startProgressValue
    ?? (evaluation.progress.kind === 'known' ? evaluation.progress.value : null),
  observedIntervals: extendIntervals(record.observedIntervals, nowMs),
  progressSamples: recordProgressSample(record.progressSamples, evaluation, nowMs),
});

export const recordNonPlannableTick = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord => ({
  ...refreshRecordCompletion(record, diag.evaluation, nowMs),
  deviceName: diag.deviceName ?? record.deviceName,
  ...refreshPlanSnapshots(record, plan),
});

const classifyOutcome = (
  record: InProgressRecord,
  reason: 'deadline_passed' | 'replaced' | 'abandoned',
): DeferredObjectivePlanTerminalOutcome => {
  if (record.satisfied) return 'met';
  if (reason === 'abandoned') return 'abandoned';
  if (reason === 'replaced') return 'replaced';
  if (record.finalProgressValue === null) return 'abandoned';
  return 'missed';
};

// The finalized run, resolved like the API resolves a stored row: the device
// name the recorder last saw (its id when it never saw one), and the kind.
// The stored row drops both (`toStoredPlanHistoryRecord`).
export const finalizeRecord = (
  record: InProgressRecord,
  nowMs: number,
  reason: 'deadline_passed' | 'replaced' | 'abandoned',
): ResolvedDeferredObjectivePlanHistoryEntry => {
  const drainedSamples = drainProgressSamples(record.progressSamples);
  const outcome = classifyOutcome(record, reason);
  return {
    id: randomUUID(),
    deliveryExplanation: record.deliveryEvidence.explanation,
    deviceId: record.deviceId,
    deviceName: record.deviceName ?? record.deviceId,
    objectiveKind: record.objectiveKind,
    targetValue: record.targetValue,
    deadlineAtMs: record.deadlineAtMs,
    startedAtMs: record.startedAtMs,
    finalizedAtMs: nowMs,
    startProgressValue: record.startProgressValue,
    finalProgressValue: record.finalProgressValue,
    progressDirection: record.finalProgressDirection,
    initialEnergyNeededKWh: record.initialEnergyNeededKWh,
    ...(record.commitment.kind === 'known'
      ? { initialEnergyExpectedKWh: record.commitment.kwh }
      : {}),
    outcome,
    metAtMs: record.metAtMs,
    // Only persist `metReason` on `met` outcomes. The contract forbids it on
    // any other outcome (see `hasValidOutcome` in `planHistorySettings.ts`),
    // and a stalled record that finalizes as `replaced` / `abandoned` should
    // not carry a `met`-only field into history.
    ...(outcome === 'met' && record.metReason !== null ? { metReason: record.metReason } : {}),
    usedDeadlineReserve: record.usedDeadlineReserve,
    observedIntervals: record.observedIntervals.slice(),
    discoveredFrom: 'observation',
    // Each snapshot already carries its OWN revision's `energyExpectedKWh`
    // from `captureRevisionSnapshot`. Nothing is stamped on here: doing that
    // put the finalize-moment figure on both snapshots, so the "original"
    // requirement the attribution compares delivery against was really the
    // energy still outstanding at the end.
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
    ...(record.hasDeliveryContribution ? { deliveredKWh: record.deliveredKWh } : {}),
    ...(record.hasDeliveryContribution && record.deliveryPriceComplete
      ? { totalCost: record.totalCost }
      : {}),
    // Persist the price-display provenance the `totalCost` was accumulated
    // under so the archive formats the figure in its recorded currency rather
    // than whatever scheme is bootstrapped when the user later reads it.
    // Non-null only when a priced contribution fired, so a delivery-only run
    // with no resolved price (and every legacy entry) omits the field and the
    // consumer falls back to the recording-era øre/kr default.
    ...(record.costDisplay !== null ? { costDisplay: record.costDisplay } : {}),
    // Per-hour contributions are persisted only when at least one was
    // appended — runs that never received a contribution stay byte-stable
    // across upgrades, mirroring the `deliveredKWh` / `totalCost`
    // suppression contract above.
    ...(record.hourlyContributions.length > 0
      ? { hourlyContributions: record.hourlyContributions.slice() }
      : {}),
    ...(record.revisions.length > 0 ? { revisions: record.revisions.slice() } : {}),
    // Present whenever the run saw at least one hour begin under a plan, even
    // one that booked nothing: presence is what tells the readers to trust
    // this record over the final revision's hours.
    ...(record.hourStartBookings.length > 0
      ? { hourStartBookings: record.hourStartBookings.slice() }
      : {}),
  };
};

// The row as stored: the device name and kind are the device's, joined back on
// at the API boundary (`toResolvedPlanHistoryEntry`).
export const toStoredPlanHistoryRecord = (
  entry: ResolvedDeferredObjectivePlanHistoryEntry,
): DeferredObjectivePlanHistoryRecord => {
  const { deviceName: _deviceName, objectiveKind: _objectiveKind, ...stored } = entry;
  return stored;
};
