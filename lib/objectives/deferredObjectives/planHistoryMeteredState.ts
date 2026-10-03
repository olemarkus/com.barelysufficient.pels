import type {
  DeferredObjectivePlanHistoryCostDisplay,
  DeferredObjectivePlanHistoryHourStartBooking,
  DeferredObjectivePlanHistoryHourlyContribution,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';
import { isHourStartBooking } from './planHistorySettings';

/**
 * What the run set out to need, as saved with its in-progress delivery.
 * `known` is the captured requirement. `unknown` means the original
 * requirement cannot be recovered from remaining need. `learning` means the run
 * had not stated one yet when it was saved, and had been delivered nothing (a
 * delivered learning run is saved as unknown, `toPersistedCommitment`): a
 * restart resumes it under the restart gate in `backfillCommitment` rather than
 * freezing it as unknown.
 */
export type MeteredRunCommitment =
  | { kind: 'known'; kwh: number }
  | { kind: 'unknown' }
  | { kind: 'learning' };

export type PersistedMeteredDeliveryState = {
  commitment: MeteredRunCommitment;
  deviceId: string;
  deadlineAtMs: number;
  startedAtMs: number;
  // The run's first trusted progress reading, or null when none was trusted
  // before the save. After a restart it stays the run's start anchor, and a
  // `learning` commitment compares the live reading against it.
  startProgressValue: number | null;
  deliveredKWh: number;
  totalCost: number;
  costDisplay: DeferredObjectivePlanHistoryCostDisplay | null;
  deliveryPriceComplete: boolean;
  hourlyContributions: DeferredObjectivePlanHistoryHourlyContribution[];
  // Hours whose start the run already saw, so a restart inside one of them
  // does not book that hour again from a plan revised after it began.
  hourStartBookings: DeferredObjectivePlanHistoryHourStartBooking[];
};

const isCommitment = (value: unknown): value is MeteredRunCommitment => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'unknown'
    || candidate.kind === 'learning'
    || (candidate.kind === 'known' && isFiniteNumber(candidate.kwh) && candidate.kwh >= 0);
};

/**
 * Upgrade rows saved before a field existed without throwing away their
 * measured delivery. A row from before commitments resolves to `unknown` (its
 * requirement can no longer be shown to be the original); one from before the
 * start anchor to an untrusted start; one from before hour-start bookings to
 * none captured. A field the row carries is kept as written and validated by
 * `isPersistedMeteredDeliveryState`.
 */
export const migrateMeteredDeliveryState = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  return {
    commitment: { kind: 'unknown' },
    startProgressValue: null,
    hourStartBookings: [],
    ...raw,
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

const hasValidRunAnchors = (candidate: Record<string, unknown>): boolean => (
  isCommitment(candidate.commitment)
    && typeof candidate.deviceId === 'string'
    && candidate.deviceId.length > 0
    && isFiniteNumber(candidate.deadlineAtMs)
    && isFiniteNumber(candidate.startedAtMs)
    && (candidate.startProgressValue === null || isFiniteNumber(candidate.startProgressValue))
    && Array.isArray(candidate.hourStartBookings)
    && candidate.hourStartBookings.every(isHourStartBooking)
);

export const isPersistedMeteredDeliveryState = (
  value: unknown,
): value is PersistedMeteredDeliveryState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return hasValidRunAnchors(candidate)
    && isFiniteNumber(candidate.deliveredKWh)
    && candidate.deliveredKWh >= 0
    && isFiniteNumber(candidate.totalCost)
    && (candidate.costDisplay === null || isCostDisplay(candidate.costDisplay))
    && typeof candidate.deliveryPriceComplete === 'boolean'
    && Array.isArray(candidate.hourlyContributions)
    && candidate.hourlyContributions.every(isHourlyContribution);
};
