import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { isFiniteNumber } from '../../utils/appTypeGuards';

export const DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION = 1 as const;

const VALID_REASONS: ReadonlySet<DeferredObjectiveActivePlanRevisionReason> = new Set([
  'flow_card',
  'prices_arrived',
  'objective_changed',
  'prices_revised',
  'rate_refined',
  'device_unavailable',
  'measured_deviation',
]);

const isKwhPerUnitSource = (value: unknown): value is 'learned' | 'bootstrap' => (
  value === 'learned' || value === 'bootstrap'
);

export const createEmptyActivePlans = (): DeferredObjectiveActivePlansV1 => ({
  version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
  plansByDeviceId: {},
});

const isFiniteOrNull = (value: unknown): value is number | null => (
  value === null || isFiniteNumber(value)
);

const isObjectiveKind = (value: unknown): value is 'temperature' | 'ev_soc' => (
  value === 'temperature' || value === 'ev_soc'
);

const isReason = (value: unknown): value is DeferredObjectiveActivePlanRevisionReason => (
  typeof value === 'string'
  && VALID_REASONS.has(value as DeferredObjectiveActivePlanRevisionReason)
);

const isPlanHour = (value: unknown): value is DeferredObjectiveActivePlanHourV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.startsAtMs) && isFiniteNumber(v.plannedKWh);
};

const isRevision = (value: unknown): value is DeferredObjectiveActivePlanRevisionV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.revision)
    && isFiniteNumber(v.revisedAtMs)
    && isFiniteOrNull(v.computedFromPricesUpTo)
    && isReason(v.reason)
    && Array.isArray(v.hours)
    && v.hours.every(isPlanHour)
    // `kwhPerUnitSource` is optional for backward compatibility with revisions
    // persisted before the bootstrap rate fallback shipped. Allow absence, but
    // if present require a known value rather than silently keeping garbage.
    && (v.kwhPerUnitSource === undefined || isKwhPerUnitSource(v.kwhPerUnitSource));
};

const isRevisionOrNull = (value: unknown): value is DeferredObjectiveActivePlanRevisionV1 | null => (
  value === null || isRevision(value)
);

const isActivePlan = (value: unknown): value is DeferredObjectiveActivePlanV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.deviceId === 'string'
    && (v.deviceName === null || typeof v.deviceName === 'string')
    && isObjectiveKind(v.objectiveKind)
    && isFiniteOrNull(v.targetTemperatureC)
    && isFiniteOrNull(v.targetPercent)
    && isFiniteNumber(v.deadlineAtMs)
    && isFiniteNumber(v.startedAtMs)
    && typeof v.pending === 'boolean'
    && typeof v.objectiveSignature === 'string'
    && isRevisionOrNull(v.original)
    && isRevisionOrNull(v.latest);
};

export const normalizeDeferredObjectiveActivePlans = (
  raw: unknown,
): DeferredObjectiveActivePlansV1 => {
  if (!raw || typeof raw !== 'object') return createEmptyActivePlans();
  const r = raw as Record<string, unknown>;
  if (r.version !== DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION) return createEmptyActivePlans();
  if (!r.plansByDeviceId || typeof r.plansByDeviceId !== 'object') return createEmptyActivePlans();
  const entries = Object.entries(r.plansByDeviceId as Record<string, unknown>)
    .filter(([, plan]) => isActivePlan(plan)) as [string, DeferredObjectiveActivePlanV1][];
  return {
    version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
    plansByDeviceId: Object.fromEntries(entries),
  };
};
