import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryObservedInterval,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  DeferredObjectivePlanHistoryV4,
  DeferredObjectivePlanOutcome,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION } from './planHistorySettings';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import { buildEndedEventFromEntry, type DeferredObjectiveEndedBus } from './endedEventBus';
import {
  appendRevisionLogIfNew,
  captureRevisionSnapshot,
  drainProgressSamples,
  hasTrustworthyProgress,
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
> & {
  satisfied: boolean;
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
    if (diag.currentTemperatureC === null || diag.targetTemperatureC === null) return false;
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
    targetTemperatureC: diag.targetTemperatureC,
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


const mergeRecord = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord => {
  const currentlySatisfied = isSatisfiedStatus(diag.status);
  const metAtMs = currentlySatisfied ? (record.metAtMs ?? nowMs) : null;
  return {
    ...record,
    deviceName: diag.deviceName ?? record.deviceName,
    ...backfillStartProgress(record, diag),
    finalProgressC: captureProgressC(diag) ?? record.finalProgressC,
    finalProgressPercent: captureProgressPercent(diag) ?? record.finalProgressPercent,
    usedDeadlineReserve: record.usedDeadlineReserve || (diag.horizonPlan?.usesDeadlineReserve ?? false),
    usedPolicyAvoid: record.usedPolicyAvoid || (diag.horizonPlan?.usesPolicyAvoid ?? false),
    observedIntervals: extendIntervals(record.observedIntervals, nowMs),
    satisfied: currentlySatisfied,
    metAtMs,
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

const recordNonPlannableTick = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): InProgressRecord => {
  if (record.satisfied && hasTrustworthyProgress(diag) && !diagnosticProgressAtTarget(diag)) {
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
    outcome: classifyOutcome(record, reason),
    metAtMs: record.metAtMs,
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
    ...(record.revisions.length > 0 ? { revisions: record.revisions.slice() } : {}),
  };
};

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
  ): void {
    const seenKeys = new Set<InProgressKey>();
    for (const diag of diagnostics) {
      if (diag.deadlineAtMs === null) continue;
      const key = buildKey(diag.deviceId, diag.deadlineAtMs);
      seenKeys.add(key);
      const existing = this.inProgress.get(key);
      const plannable = isPlannableStatus(diag.status) || isSatisfiedStatus(diag.status);
      const plan = findPlanForRecord(activePlans, { deviceId: diag.deviceId, deadlineAtMs: diag.deadlineAtMs });
      if (existing) {
        // Plannable diagnostics roll forward progress + planning flags. Unknown/invalid still
        // count as observation ("PELS was watching"). If an already-met run later reports
        // trustworthy below-target progress, clear the live met marker; otherwise preserve
        // the last trustworthy progress.
        const next = plannable
          ? mergeRecord(existing, diag, nowMs, plan)
          : recordNonPlannableTick(existing, diag, nowMs, plan);
        this.inProgress.set(key, next);
        continue;
      }
      // Begin tracking on first sight of a future-dated deadline, regardless of status. The
      // deadline event is the recorded thing; observation quality is captured separately via
      // observedIntervals + progress nullability. The stale-deadline guard still applies so a
      // diagnostic whose deadline has already passed doesn't create a junk record finalized on
      // the same cycle.
      if (diag.deadlineAtMs <= nowMs) continue;
      const next = startRecord(diag, nowMs, plan);
      if (next) this.inProgress.set(key, next);
    }
    this.finalizeStaleRecords(seenKeys, nowMs);
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
      this.pushEntry(finalizeRecord(record, nowMs, reason));
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
    this.inProgress.set(key, {
      ...record,
      deliveredKWh: record.deliveredKWh + contribution.deliveredKWh,
      totalCost: record.totalCost + contribution.priceValue * contribution.deliveredKWh,
      hasDeliveryContribution: true,
    });
  }

  private finalizeStaleRecords(seenKeys: ReadonlySet<InProgressKey>, nowMs: number): void {
    for (const [key, record] of this.inProgress) {
      if (record.deadlineAtMs <= nowMs) {
        this.pushEntry(finalizeRecord(record, nowMs, 'deadline_passed'));
        this.inProgress.delete(key);
        continue;
      }
      if (seenKeys.has(key)) continue;
      // Diagnostic stopped appearing while deadline is still future. Wait for the grace
      // window before declaring the run abandoned, in case the device briefly drops out and
      // recovers.
      if (nowMs - lastObservedAtMs(record) >= ABANDON_GRACE_MS) {
        this.pushEntry(finalizeRecord(record, nowMs, 'abandoned'));
        this.inProgress.delete(key);
      }
    }
  }

  private pushEntry(entry: DeferredObjectivePlanHistoryEntry): void {
    this.entries.push(entry);
    this.trimEntries();
    this.dirty = true;
    const endedEvent = buildEndedEventFromEntry(entry);
    if (endedEvent !== null) {
      this.deps.endedBus?.publish(endedEvent);
    }
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
