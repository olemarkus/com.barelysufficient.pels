import { isTaskDeliveryEvidence } from './taskDeliveryValidation';
import type { TaskDeliveryEvidence } from '../../../packages/contracts/src/taskDelivery';
import { LEGACY_DELIVERY_EVIDENCE } from './deliveryEvidence';
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
 * had not stated one yet when it was saved, had been delivered nothing and had
 * a trusted start reading, which it carries as the anchor the restart gate in
 * `backfillCommitment` compares against. A learning run with delivery or with
 * no trusted start is saved as unknown (`toPersistedCommitment` in
 * `planHistoryMeteredRun.ts`).
 */
export type MeteredRunCommitment =
  | { kind: 'known'; kwh: number }
  | { kind: 'unknown' }
  | { kind: 'learning'; startProgressValue: number };

export type PersistedMeteredDeliveryState = {
  deliveryEvidence: TaskDeliveryEvidence;
  commitment: MeteredRunCommitment;
  deviceId: string;
  deadlineAtMs: number;
  startedAtMs: number;
  // The run's first trusted progress reading, or null when none was trusted
  // before the save. After a restart it stays the run's start reading.
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
    || (candidate.kind === 'learning' && isFiniteNumber(candidate.startProgressValue))
    || (candidate.kind === 'known' && isFiniteNumber(candidate.kwh) && candidate.kwh >= 0);
};

/**
 * Upgrade rows saved before a field existed without throwing away their
 * measured delivery: no commitment reads as unknown, no delivery evidence as
 * legacy, no start progress as untrusted, no hour-start bookings as none
 * captured. A row saved as `unknown` stays unknown: every run an older build
 * saved while still learning was written that way, and nothing in the row can
 * show its requirement is still the original.
 *
 * Accepted one-time artifact: a run in flight when a device first upgrades to
 * the build that records hour-start bookings restores with none, so its
 * finalized entry carries only the hours that began after the upgrade, and the
 * readers take that list as complete (earlier hours read "Not scheduled", the
 * logged planned total runs low, the coverage line is hidden). Every later run
 * records from its first hour.
 */
export const migrateMeteredDeliveryState = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  return {
    ...raw,
    ...('commitment' in raw ? {} : { commitment: { kind: 'unknown' } }),
    ...('deliveryEvidence' in raw ? {} : { deliveryEvidence: LEGACY_DELIVERY_EVIDENCE }),
    ...('startProgressValue' in raw ? {} : { startProgressValue: null }),
    ...('hourStartBookings' in raw ? {} : { hourStartBookings: [] }),
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

// The run's window and start anchor.
const hasValidRunWindow = (candidate: Record<string, unknown>): boolean => (
  isFiniteNumber(candidate.deadlineAtMs)
    && isFiniteNumber(candidate.startedAtMs)
    && (candidate.startProgressValue === null || isFiniteNumber(candidate.startProgressValue))
);

// Both per-hour lists; the bookings share the finalized entry's guard.
const hasValidHourLists = (candidate: Record<string, unknown>): boolean => (
  isContributionList(candidate.hourlyContributions)
    && Array.isArray(candidate.hourStartBookings)
    && candidate.hourStartBookings.every(isHourStartBooking)
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
    && hasValidRunWindow(candidate)
    && isFiniteNumber(candidate.deliveredKWh)
    && candidate.deliveredKWh >= 0
    && isFiniteNumber(candidate.totalCost)
    && (candidate.costDisplay === null || isCostDisplay(candidate.costDisplay))
    && typeof candidate.deliveryPriceComplete === 'boolean'
    && hasValidHourLists(candidate);
};
