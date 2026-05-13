import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanStatusV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryDiscoveredFrom,
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryEntryV1,
  DeferredObjectivePlanHistoryEntryV2,
  DeferredObjectivePlanHistoryObservedInterval,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  DeferredObjectivePlanHistoryV3,
  DeferredObjectivePlanOutcome,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import { randomUUID } from 'node:crypto';

export const DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION = 3 as const;

const createEmptyDeferredObjectivePlanHistory = (): DeferredObjectivePlanHistoryV3 => ({
  version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
  entries: [],
});

const isOutcome = (value: unknown): value is DeferredObjectivePlanOutcome => (
  value === 'met'
    || value === 'missed'
    || value === 'abandoned'
    || value === 'replaced'
    || value === 'unknown'
);

const isFiniteOrNull = (value: unknown): value is number | null => (
  value === null || isFiniteNumber(value)
);

const isObjectiveKind = (value: unknown): value is 'temperature' | 'ev_soc' => (
  value === 'temperature' || value === 'ev_soc'
);

const isDiscoveredFrom = (value: unknown): value is DeferredObjectivePlanHistoryDiscoveredFrom => (
  value === 'observation' || value === 'backfill'
);

const isObservedInterval = (value: unknown): value is DeferredObjectivePlanHistoryObservedInterval => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.fromMs) && isFiniteNumber(v.toMs);
};

const isPlanStatus = (value: unknown): value is DeferredObjectiveActivePlanStatusV1 => (
  value === 'at_risk'
    || value === 'cannot_meet'
    || value === 'invalid'
    || value === 'on_track'
    || value === 'satisfied'
);

const isPlanHour = (value: unknown): value is DeferredObjectiveActivePlanHourV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.startsAtMs) && isFiniteNumber(v.plannedKWh);
};

const isRevisionSnapshot = (
  value: unknown,
): value is DeferredObjectivePlanHistoryRevisionSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.hours)
    && v.hours.every(isPlanHour)
    && isFiniteNumber(v.energyNeededKWh)
    && isPlanStatus(v.planStatus)
    && isFiniteNumber(v.revisedAtMs);
};

const isRevisionSnapshotOrNull = (
  value: unknown,
): value is DeferredObjectivePlanHistoryRevisionSnapshot | null => (
  value === null || isRevisionSnapshot(value)
);

const hasValidIdentity = (v: Record<string, unknown>): boolean => (
  typeof v.deviceId === 'string'
    && (v.deviceName === null || typeof v.deviceName === 'string')
    && isObjectiveKind(v.objectiveKind)
);

const hasValidTargets = (v: Record<string, unknown>): boolean => (
  isFiniteOrNull(v.targetTemperatureC) && isFiniteOrNull(v.targetPercent)
);

const hasValidTimestamps = (v: Record<string, unknown>): boolean => (
  isFiniteNumber(v.deadlineAtMs)
    && isFiniteNumber(v.startedAtMs)
    && isFiniteNumber(v.finalizedAtMs)
    && isFiniteOrNull(v.metAtMs)
);

const hasValidProgress = (v: Record<string, unknown>): boolean => (
  isFiniteOrNull(v.startProgressC)
    && isFiniteOrNull(v.startProgressPercent)
    && isFiniteOrNull(v.finalProgressC)
    && isFiniteOrNull(v.finalProgressPercent)
    && isFiniteNumber(v.initialEnergyNeededKWh)
);

const hasValidOutcome = (v: Record<string, unknown>): boolean => (
  isOutcome(v.outcome)
    && typeof v.usedDeadlineReserve === 'boolean'
    && typeof v.usedPolicyAvoid === 'boolean'
);

const hasValidCoverage = (v: Record<string, unknown>): boolean => (
  Array.isArray(v.observedIntervals)
    && v.observedIntervals.every(isObservedInterval)
    && isDiscoveredFrom(v.discoveredFrom)
);

const hasValidPlanSnapshots = (v: Record<string, unknown>): boolean => (
  isRevisionSnapshotOrNull(v.originalPlan) && isRevisionSnapshotOrNull(v.finalPlan)
);

const isV1EntryShape = (value: unknown): value is DeferredObjectivePlanHistoryEntryV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return hasValidIdentity(v)
    && hasValidTargets(v)
    && hasValidTimestamps(v)
    && hasValidProgress(v)
    && hasValidOutcome(v);
};

const isV2EntryShape = (value: unknown): value is DeferredObjectivePlanHistoryEntryV2 => {
  if (!isV1EntryShape(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return hasValidCoverage(v);
};

const isPlanHistoryEntry = (value: unknown): value is DeferredObjectivePlanHistoryEntry => {
  if (!isV2EntryShape(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return typeof v.id === 'string' && v.id.length > 0 && hasValidPlanSnapshots(v);
};

const upgradeV1Entry = (
  entry: DeferredObjectivePlanHistoryEntryV1,
): DeferredObjectivePlanHistoryEntry => ({
  ...entry,
  id: randomUUID(),
  observedIntervals: [{ fromMs: entry.startedAtMs, toMs: entry.finalizedAtMs }],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
});

const upgradeV2Entry = (
  entry: DeferredObjectivePlanHistoryEntryV2,
): DeferredObjectivePlanHistoryEntry => ({
  ...entry,
  id: randomUUID(),
  originalPlan: null,
  finalPlan: null,
});

const normalizeV1 = (entries: unknown[]): DeferredObjectivePlanHistoryEntry[] => (
  entries.filter(isV1EntryShape).map(upgradeV1Entry)
);

const normalizeV2 = (entries: unknown[]): DeferredObjectivePlanHistoryEntry[] => (
  entries.filter(isV2EntryShape).map(upgradeV2Entry)
);

const normalizeV3 = (entries: unknown[]): DeferredObjectivePlanHistoryEntry[] => (
  entries.filter(isPlanHistoryEntry)
);

export const normalizeDeferredObjectivePlanHistory = (
  raw: unknown,
): DeferredObjectivePlanHistoryV3 => {
  if (!raw || typeof raw !== 'object') return createEmptyDeferredObjectivePlanHistory();
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.entries)) return createEmptyDeferredObjectivePlanHistory();
  if (r.version === DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION) {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: normalizeV3(r.entries),
    };
  }
  if (r.version === 2) {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: normalizeV2(r.entries),
    };
  }
  if (r.version === 1) {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: normalizeV1(r.entries),
    };
  }
  return createEmptyDeferredObjectivePlanHistory();
};
