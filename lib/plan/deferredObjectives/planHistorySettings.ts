import type {
  DeferredObjectivePlanHistoryDiscoveredFrom,
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryEntryV1,
  DeferredObjectivePlanHistoryObservedInterval,
  DeferredObjectivePlanHistoryV2,
  DeferredObjectivePlanOutcome,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { isFiniteNumber } from '../../utils/appTypeGuards';

export const DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION = 2 as const;

const createEmptyDeferredObjectivePlanHistory = (): DeferredObjectivePlanHistoryV2 => ({
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

const isV1EntryShape = (value: unknown): value is DeferredObjectivePlanHistoryEntryV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return hasValidIdentity(v)
    && hasValidTargets(v)
    && hasValidTimestamps(v)
    && hasValidProgress(v)
    && hasValidOutcome(v);
};

const isPlanHistoryEntry = (value: unknown): value is DeferredObjectivePlanHistoryEntry => {
  if (!isV1EntryShape(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return hasValidCoverage(v);
};

const upgradeV1Entry = (entry: DeferredObjectivePlanHistoryEntryV1): DeferredObjectivePlanHistoryEntry => ({
  ...entry,
  observedIntervals: [{ fromMs: entry.startedAtMs, toMs: entry.finalizedAtMs }],
  discoveredFrom: 'observation',
});

const normalizeV1 = (entries: unknown[]): DeferredObjectivePlanHistoryEntry[] => (
  entries.filter(isV1EntryShape).map(upgradeV1Entry)
);

const normalizeV2 = (entries: unknown[]): DeferredObjectivePlanHistoryEntry[] => (
  entries.filter(isPlanHistoryEntry)
);

export const normalizeDeferredObjectivePlanHistory = (
  raw: unknown,
): DeferredObjectivePlanHistoryV2 => {
  if (!raw || typeof raw !== 'object') return createEmptyDeferredObjectivePlanHistory();
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.entries)) return createEmptyDeferredObjectivePlanHistory();
  if (r.version === DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION) {
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
