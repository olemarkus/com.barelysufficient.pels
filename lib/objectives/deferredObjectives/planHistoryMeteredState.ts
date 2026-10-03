import { isTaskDeliveryEvidence } from '../../../packages/shared-domain/src/taskDeliveryValidation';
import type { TaskDeliveryEvidence } from '../../../packages/contracts/src/taskDelivery';
import { LEGACY_DELIVERY_EVIDENCE } from './deliveryEvidence';
import type {
  DeferredObjectivePlanHistoryCostDisplay,
  DeferredObjectivePlanHistoryHourlyContribution,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';

/** Unknown means the run's original requirement cannot be recovered from remaining need. */
export type MeteredRunCommitment = { kind: 'known'; kwh: number } | { kind: 'unknown' };

export type PersistedMeteredDeliveryState = {
  deliveryEvidence: TaskDeliveryEvidence;
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
  if (!raw || typeof raw !== 'object') return raw;
  return {
    ...raw,
    ...('commitment' in raw ? {} : { commitment: { kind: 'unknown' } }),
    ...('deliveryEvidence' in raw ? {} : { deliveryEvidence: LEGACY_DELIVERY_EVIDENCE }),
  };
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

const isContributionList = (value: unknown): boolean => (
  Array.isArray(value) && value.every(isHourlyContribution)
);

export const isPersistedMeteredDeliveryState = (
  value: unknown,
): value is PersistedMeteredDeliveryState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return isTaskDeliveryEvidence(candidate.deliveryEvidence)
    && isCommitment(candidate.commitment)
    && typeof candidate.deviceId === 'string'
    && candidate.deviceId.length > 0
    && isFiniteNumber(candidate.deadlineAtMs)
    && isFiniteNumber(candidate.startedAtMs)
    && isFiniteNumber(candidate.deliveredKWh)
    && candidate.deliveredKWh >= 0
    && isFiniteNumber(candidate.totalCost)
    && (candidate.costDisplay === null || isCostDisplay(candidate.costDisplay))
    && typeof candidate.deliveryPriceComplete === 'boolean'
    && isContributionList(candidate.hourlyContributions);
};
