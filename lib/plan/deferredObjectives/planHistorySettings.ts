import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryV1,
  DeferredObjectivePlanOutcome,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { isFiniteNumber } from '../../utils/appTypeGuards';

export const DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION = 1 as const;

const createEmptyDeferredObjectivePlanHistory = (): DeferredObjectivePlanHistoryV1 => ({
  version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
  entries: [],
});

const isOutcome = (value: unknown): value is DeferredObjectivePlanOutcome => (
  value === 'met' || value === 'missed' || value === 'abandoned' || value === 'unknown'
);

const isFiniteOrNull = (value: unknown): value is number | null => (
  value === null || isFiniteNumber(value)
);

const isObjectiveKind = (value: unknown): value is 'temperature' | 'ev_soc' => (
  value === 'temperature' || value === 'ev_soc'
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

const isPlanHistoryEntry = (value: unknown): value is DeferredObjectivePlanHistoryEntry => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return hasValidIdentity(v)
    && hasValidTargets(v)
    && hasValidTimestamps(v)
    && hasValidProgress(v)
    && hasValidOutcome(v);
};

export const normalizeDeferredObjectivePlanHistory = (
  raw: unknown,
): DeferredObjectivePlanHistoryV1 => {
  if (!raw || typeof raw !== 'object') return createEmptyDeferredObjectivePlanHistory();
  const r = raw as Record<string, unknown>;
  if (r.version !== DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION) {
    return createEmptyDeferredObjectivePlanHistory();
  }
  if (!Array.isArray(r.entries)) return createEmptyDeferredObjectivePlanHistory();
  return {
    version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
    entries: r.entries.filter(isPlanHistoryEntry),
  };
};
