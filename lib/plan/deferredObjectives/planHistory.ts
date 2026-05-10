import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryV1,
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

type InProgressKey = string; // `${deviceId}|${deadlineAtMs}`

type InProgressRecord = Omit<DeferredObjectivePlanHistoryEntry, 'finalizedAtMs' | 'outcome'> & {
  lastSeenAtMs: number;
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
    lastSeenAtMs: nowMs,
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
    lastSeenAtMs: nowMs,
    satisfied: record.satisfied || reachedSatisfied,
    metAtMs: reachedSatisfied ? nowMs : record.metAtMs,
  };
};

const refreshLastSeen = (
  record: InProgressRecord,
  nowMs: number,
): InProgressRecord => ({ ...record, lastSeenAtMs: nowMs });

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
  if (reason === 'replaced') return 'abandoned';
  if (record.finalProgressC === null && record.finalProgressPercent === null) return 'unknown';
  return 'missed';
};

const finalizeRecord = (
  record: InProgressRecord,
  nowMs: number,
  reason: 'deadline_passed' | 'replaced' | 'abandoned',
): DeferredObjectivePlanHistoryEntry => {
  const outcome = classifyOutcome(record, reason);
  return {
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
    usedDeadlineReserve: record.usedDeadlineReserve,
    usedPolicyAvoid: record.usedPolicyAvoid,
  };
};

export type PlanHistoryPersistDeps = {
  load: () => DeferredObjectivePlanHistoryV1 | null;
  save: (history: DeferredObjectivePlanHistoryV1) => void;
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
        // Always refresh lastSeenAtMs so a transient unknown/invalid status doesn't trip the
        // abandoned grace timer. Only roll forward progress + planning flags when we have a
        // plannable diagnostic — unknown/invalid means inputs aren't trustworthy.
        const next = plannable ? mergeRecord(existing, diag, nowMs) : refreshLastSeen(existing, nowMs);
        this.inProgress.set(key, next);
        continue;
      }
      // Only start tracking a new run once we see a plannable diagnostic with a deadline that
      // is still in the future. A diagnostic whose deadline has already passed (e.g. a stale
      // evaluation just before the next-day rollover) would otherwise create a record that
      // gets finalized on the same cycle, producing a no-op/garbage entry.
      if (!plannable || diag.deadlineAtMs <= nowMs) continue;
      const next = startRecord(diag, nowMs);
      if (next) this.inProgress.set(key, next);
    }
    this.finalizeStaleRecords(seenKeys, nowMs);
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
      // window before declaring the run abandoned, in case the device briefly drops to
      // unknown and recovers.
      if (nowMs - record.lastSeenAtMs >= ABANDON_GRACE_MS) {
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
    this.deps.save({
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: this.entries.slice(),
    });
    this.dirty = false;
    return true;
  }

  getHistorySnapshot(): DeferredObjectivePlanHistoryV1 {
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
