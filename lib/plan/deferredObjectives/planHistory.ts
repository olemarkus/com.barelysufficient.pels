import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryObservedInterval,
  DeferredObjectivePlanHistoryV2,
  DeferredObjectivePlanOutcome,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION } from './planHistorySettings';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
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
  'finalizedAtMs' | 'outcome' | 'discoveredFrom'
> & {
  satisfied: boolean;
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

const startRecord = (diag: DeferredObjectiveDiagnostic, nowMs: number): InProgressRecord | null => {
  if (diag.deadlineAtMs === null) return null;
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
    metAtMs: null,
    usedDeadlineReserve: diag.horizonPlan?.usesDeadlineReserve ?? false,
    usedPolicyAvoid: diag.horizonPlan?.usesPolicyAvoid ?? false,
    observedIntervals: [{ fromMs: nowMs, toMs: nowMs }],
    satisfied: false,
  };
};

const mergeRecord = (
  record: InProgressRecord,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
): InProgressRecord => {
  const reachedSatisfied = !record.satisfied && isSatisfiedStatus(diag.status);
  return {
    ...record,
    deviceName: diag.deviceName ?? record.deviceName,
    finalProgressC: captureProgressC(diag) ?? record.finalProgressC,
    finalProgressPercent: captureProgressPercent(diag) ?? record.finalProgressPercent,
    usedDeadlineReserve: record.usedDeadlineReserve || (diag.horizonPlan?.usesDeadlineReserve ?? false),
    usedPolicyAvoid: record.usedPolicyAvoid || (diag.horizonPlan?.usesPolicyAvoid ?? false),
    observedIntervals: extendIntervals(record.observedIntervals, nowMs),
    satisfied: record.satisfied || reachedSatisfied,
    metAtMs: reachedSatisfied ? nowMs : record.metAtMs,
  };
};

const recordObservedTick = (
  record: InProgressRecord,
  nowMs: number,
): InProgressRecord => ({
  ...record,
  observedIntervals: extendIntervals(record.observedIntervals, nowMs),
});

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
): DeferredObjectivePlanHistoryEntry => ({
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
});

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
});

export type PlanHistoryPersistDeps = {
  load: () => DeferredObjectivePlanHistoryV2 | null;
  // Persist the snapshot. Return `true` on success, `false` on failure (e.g. the underlying
  // settings.set threw and the host swallowed it). A `false` return keeps the recorder dirty
  // so a later flush retries, and lets callers gate side-effects (like advancing the
  // observation watermark) on real persistence success.
  save: (history: DeferredObjectivePlanHistoryV2) => boolean;
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

  observe(diagnostics: readonly DeferredObjectiveDiagnostic[], nowMs: number): void {
    const seenKeys = new Set<InProgressKey>();
    for (const diag of diagnostics) {
      if (diag.deadlineAtMs === null) continue;
      const key = buildKey(diag.deviceId, diag.deadlineAtMs);
      seenKeys.add(key);
      const existing = this.inProgress.get(key);
      const plannable = isPlannableStatus(diag.status) || isSatisfiedStatus(diag.status);
      if (existing) {
        // Plannable diagnostics roll forward progress + planning flags. Unknown/invalid still
        // count as observation ("PELS was watching") so the interval extends, but progress
        // fields stay frozen at the last trustworthy value.
        const next = plannable ? mergeRecord(existing, diag, nowMs) : recordObservedTick(existing, nowMs);
        this.inProgress.set(key, next);
        continue;
      }
      // Begin tracking on first sight of a future-dated deadline, regardless of status. The
      // deadline event is the recorded thing; observation quality is captured separately via
      // observedIntervals + progress nullability. The stale-deadline guard still applies so a
      // diagnostic whose deadline has already passed doesn't create a junk record finalized on
      // the same cycle.
      if (diag.deadlineAtMs <= nowMs) continue;
      const next = startRecord(diag, nowMs);
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

  getHistorySnapshot(): DeferredObjectivePlanHistoryV2 {
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
