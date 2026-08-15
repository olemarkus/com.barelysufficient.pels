import { buildPelsStatus } from './pelsStatus';
import { PriceLevel } from '../price/priceLevels';
import type { DevicePlan } from './planTypes';

const PLAN_META_KW_STEP = 0.1;
const PLAN_META_KWH_STEP = 0.01;

export type PlanStatusInputChanges = {
  actionSignature?: string;
  detailSignature?: string;
  metaSignature?: string;
};

/**
 * ONE rounding helper, overloaded to preserve its input's nullish-ness.
 *
 * There were four — `roundRequired`, `roundNullable`, `roundOptional`,
 * `roundOptionalNullable` — doing identical arithmetic and differing only in
 * which absent-ness they threaded through. That fan-out was a symptom of the
 * meta type, where the same quantity was required in one place, optional in
 * another and both in a third. With `DevicePlan['meta']` saying what it means,
 * the callers no longer have to pick a variant and the compiler picks for them.
 *
 * The `typeof value !== 'number'` guard is load-bearing for the nullish
 * overloads and not merely an early return: `Math.round(null / 0.1) * 0.1` is
 * `0`, so without it a "no reading" `null` would round into a real-looking
 * zero. For a finite number the guard changes nothing (rounding `NaN` is `NaN`
 * either way), so the required overload behaves exactly as `roundRequired` did.
 */
function roundTo(value: number, step: number): number;
function roundTo(value: number | null, step: number): number | null;
function roundTo(value: number | undefined, step: number): number | undefined;
function roundTo(value: number | null | undefined, step: number): number | null | undefined;
function roundTo(value: number | null | undefined, step: number): number | null | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
}

const normalizeMinutesRemaining = (value: number): number => {
  if (!Number.isFinite(value)) return value;
  return Math.max(0, Math.round(value));
};

const normalizeDailyPaceComposition = (
  meta: DevicePlan['meta'],
): Pick<DevicePlan['meta'], 'dailySoftLimitKw' | 'budgetPaceKw' | 'projectedExemptKw'> => {
  const dailySoftLimitKw = roundTo(meta.dailySoftLimitKw, PLAN_META_KW_STEP);
  const projectedExemptKw = roundTo(meta.projectedExemptKw, PLAN_META_KW_STEP);
  const hasCompleteComposition = typeof dailySoftLimitKw === 'number'
    && Number.isFinite(dailySoftLimitKw)
    && typeof projectedExemptKw === 'number'
    && Number.isFinite(projectedExemptKw)
    && typeof meta.budgetPaceKw === 'number'
    && Number.isFinite(meta.budgetPaceKw);

  return {
    dailySoftLimitKw,
    budgetPaceKw: hasCompleteComposition
      ? Number((dailySoftLimitKw - projectedExemptKw).toFixed(1))
      : roundTo(meta.budgetPaceKw, PLAN_META_KW_STEP),
    projectedExemptKw,
  };
};

export const normalizePlanMeta = (meta: DevicePlan['meta']): DevicePlan['meta'] => {
  const dailyPaceComposition = normalizeDailyPaceComposition(meta);
  return {
    ...meta,
    totalKw: roundTo(meta.totalKw, PLAN_META_KW_STEP),
    // The `?? meta.softLimitKw` tail this used to carry existed only to restore
    // required-ness after `roundOptional` widened it to `| undefined`. The
    // overload keeps a required number required, so the tail is gone.
    softLimitKw: roundTo(meta.softLimitKw, PLAN_META_KW_STEP),
    capacitySoftLimitKw: roundTo(meta.capacitySoftLimitKw, PLAN_META_KW_STEP),
    ...dailyPaceComposition,
    headroomKw: roundTo(meta.headroomKw, PLAN_META_KW_STEP),
    shortfallBudgetThresholdKw: roundTo(meta.shortfallBudgetThresholdKw, PLAN_META_KW_STEP),
    shortfallBudgetHeadroomKw: roundTo(meta.shortfallBudgetHeadroomKw, PLAN_META_KW_STEP),
    hardCapLimitKw: roundTo(meta.hardCapLimitKw, PLAN_META_KW_STEP),
    hardCapHeadroomKw: roundTo(meta.hardCapHeadroomKw, PLAN_META_KW_STEP),
    usedKWh: roundTo(meta.usedKWh, PLAN_META_KWH_STEP),
    budgetKWh: roundTo(meta.budgetKWh, PLAN_META_KWH_STEP),
    capacityLimitKw: roundTo(meta.capacityLimitKw, PLAN_META_KW_STEP),
    minutesRemaining: normalizeMinutesRemaining(meta.minutesRemaining),
    controlledKw: roundTo(meta.controlledKw, PLAN_META_KW_STEP),
    uncontrolledKw: roundTo(meta.uncontrolledKw, PLAN_META_KW_STEP),
    hourControlledKWh: roundTo(meta.hourControlledKWh, PLAN_META_KWH_STEP),
    hourUncontrolledKWh: roundTo(meta.hourUncontrolledKWh, PLAN_META_KWH_STEP),
    dailyBudgetRemainingKWh: roundTo(meta.dailyBudgetRemainingKWh, PLAN_META_KWH_STEP),
    dailyBudgetHourKWh: roundTo(meta.dailyBudgetHourKWh, PLAN_META_KWH_STEP),
  };
};

export const normalizePelsStatus = (
  status: ReturnType<typeof buildPelsStatus>['status'],
  powerBucketMs: number,
): ReturnType<typeof buildPelsStatus>['status'] => {
  const safeBucketMs = Math.max(1, powerBucketMs);
  const lastPowerUpdate = typeof status.lastPowerUpdate === 'number' && Number.isFinite(status.lastPowerUpdate)
    ? Math.floor(status.lastPowerUpdate / safeBucketMs) * safeBucketMs
    : status.lastPowerUpdate;

  return {
    ...status,
    headroomKw: roundTo(status.headroomKw, PLAN_META_KW_STEP),
    hourlyLimitKw: roundTo(status.hourlyLimitKw, PLAN_META_KW_STEP),
    hourlyUsageKwh: roundTo(status.hourlyUsageKwh, PLAN_META_KWH_STEP) ?? status.hourlyUsageKwh,
    dailyBudgetRemainingKwh: roundTo(status.dailyBudgetRemainingKwh, PLAN_META_KWH_STEP),
    shortfallBudgetThresholdKw: roundTo(status.shortfallBudgetThresholdKw, PLAN_META_KW_STEP),
    shortfallBudgetHeadroomKw: roundTo(status.shortfallBudgetHeadroomKw, PLAN_META_KW_STEP),
    hardCapHeadroomKw: roundTo(status.hardCapHeadroomKw, PLAN_META_KW_STEP),
    totalKw: roundTo(status.totalKw, PLAN_META_KW_STEP),
    controlledKw: roundTo(status.controlledKw, PLAN_META_KW_STEP),
    uncontrolledKw: roundTo(status.uncontrolledKw, PLAN_META_KW_STEP),
    lastPowerUpdate,
  };
};

export const normalizeLastPowerUpdate = (
  lastPowerUpdate: number | null,
  powerBucketMs: number,
): number | null => {
  if (typeof lastPowerUpdate !== 'number' || !Number.isFinite(lastPowerUpdate)) return lastPowerUpdate;
  const safeBucketMs = Math.max(1, powerBucketMs);
  return Math.floor(lastPowerUpdate / safeBucketMs) * safeBucketMs;
};

const hasCombinedPrices = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const record = value as { days?: unknown };
  if (!record.days || typeof record.days !== 'object' || Array.isArray(record.days)) return false;
  for (const day of Object.values(record.days as Record<string, unknown>)) {
    if (day && typeof day === 'object'
      && Array.isArray((day as { hours?: unknown }).hours)
      && ((day as { hours: unknown[] }).hours.length > 0)) return true;
  }
  return false;
};

const resolveStatusPriceKey = (params: {
  isCheap: boolean;
  isExpensive: boolean;
  combinedPrices: unknown;
}): PriceLevel => {
  const { isCheap, isExpensive, combinedPrices } = params;
  if (!hasCombinedPrices(combinedPrices)) return PriceLevel.UNKNOWN;
  if (isCheap) return PriceLevel.CHEAP;
  if (isExpensive) return PriceLevel.EXPENSIVE;
  return PriceLevel.NORMAL;
};

const resolveDryRunKey = (dryRunEffective: boolean | undefined): string => {
  if (dryRunEffective === undefined) return 'na';
  return dryRunEffective ? 'sim' : 'live';
};

export const buildPelsStatusInputKey = (params: {
  changes?: PlanStatusInputChanges;
  isCheap: boolean;
  isExpensive: boolean;
  combinedPrices: unknown;
  lastPowerUpdate: number | null;
  powerFreshnessState?: DevicePlan['meta']['powerFreshnessState'];
  powerNowKw?: number | null;
  dryRunEffective?: boolean;
}): string => {
  const {
    changes, isCheap, isExpensive, combinedPrices, lastPowerUpdate, powerFreshnessState, powerNowKw, dryRunEffective,
  } = params;
  const actionSignature = changes?.actionSignature ?? '';
  const detailSignature = changes?.detailSignature ?? '';
  const metaSignature = changes?.metaSignature ?? '';
  const priceKey = resolveStatusPriceKey({ isCheap, isExpensive, combinedPrices });
  const lastPowerUpdateKey = lastPowerUpdate === null ? 'null' : String(lastPowerUpdate);
  const freshnessKey = powerFreshnessState ?? 'none';
  // PRESENCE only, not the value: the figure moves every sample and would bust
  // the status cache on each one. What must bust it is the transition between
  // having a measurement and not — which `freshnessKey` alone misses, because a
  // fresh tracker with a null total (an in-place meter swap) is still 'fresh'.
  const powerNowKey = powerNowKw === null || powerNowKw === undefined ? 'unknown' : 'known';
  // Fold the effective dry-run in so a posture flip (membership becoming ready,
  // or the persisted flag toggled) busts the cache and forces a status write.
  const dryRunKey = resolveDryRunKey(dryRunEffective);
  return [
    actionSignature,
    detailSignature,
    metaSignature,
    priceKey,
    lastPowerUpdateKey,
    freshnessKey,
    powerNowKey,
    dryRunKey,
  ].join('|');
};
