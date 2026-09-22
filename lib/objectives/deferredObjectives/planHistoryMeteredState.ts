import type {
  DeferredObjectivePlanHistoryCostDisplay,
  DeferredObjectivePlanHistoryHourlyContribution,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { isFiniteNumber } from '../../utils/appTypeGuards';

/** Unknown means the run's original requirement cannot be recovered from remaining need. */
export type MeteredRunCommitment = { kind: 'known'; kwh: number } | { kind: 'unknown' };

export type PersistedMeteredDeliveryState = {
  commitment: MeteredRunCommitment;
  deviceId: string;
  deadlineAtMs: number;
  startedAtMs: number;
  deliveredKWh: number;
  totalCost: number;
  costDisplay: DeferredObjectivePlanHistoryCostDisplay | null;
  deliveryPriceComplete: boolean;
  hourlyContributions: DeferredObjectivePlanHistoryHourlyContribution[];
};

const isCommitment = (value: unknown): value is MeteredRunCommitment => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'unknown'
    || (candidate.kind === 'known' && isFiniteNumber(candidate.kwh) && candidate.kwh >= 0);
};

/** Upgrade pre-commitment rows without throwing away their measured delivery. */
export const migrateMeteredDeliveryCommitment = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || 'commitment' in raw) return raw;
  return { ...raw, commitment: { kind: 'unknown' } };
};

const isCostDisplay = (value: unknown): value is DeferredObjectivePlanHistoryCostDisplay => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.unit === 'string'
    && candidate.unit.length > 0
    && isFiniteNumber(candidate.divisor)
    && candidate.divisor > 0;
};

const isTone = (value: unknown): boolean => (
  value === 'cheap' || value === 'normal' || value === 'expensive'
);

const isHourlyContribution = (value: unknown): value is DeferredObjectivePlanHistoryHourlyContribution => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return isFiniteNumber(candidate.atMs)
    && isFiniteNumber(candidate.deliveredKWh)
    && candidate.deliveredKWh >= 0
    && isFiniteNumber(candidate.priceValue)
    && isTone(candidate.tone);
};

export const isPersistedMeteredDeliveryState = (
  value: unknown,
): value is PersistedMeteredDeliveryState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return isCommitment(candidate.commitment)
    && typeof candidate.deviceId === 'string'
    && candidate.deviceId.length > 0
    && isFiniteNumber(candidate.deadlineAtMs)
    && isFiniteNumber(candidate.startedAtMs)
    && isFiniteNumber(candidate.deliveredKWh)
    && candidate.deliveredKWh >= 0
    && isFiniteNumber(candidate.totalCost)
    && (candidate.costDisplay === null || isCostDisplay(candidate.costDisplay))
    && typeof candidate.deliveryPriceComplete === 'boolean'
    && Array.isArray(candidate.hourlyContributions)
    && candidate.hourlyContributions.every(isHourlyContribution);
};
