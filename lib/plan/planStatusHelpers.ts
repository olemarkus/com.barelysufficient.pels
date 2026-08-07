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

const roundNullable = (value: number | null, step: number): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
};

const roundOptional = (value: number | undefined, step: number): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
};

const roundOptionalNullable = (
  value: number | null | undefined,
  step: number,
): number | null | undefined => {
  if (value === null || value === undefined) return value;
  return roundNullable(value, step);
};

const normalizeMinutesRemaining = (value: number | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.max(0, Math.round(value));
};

const roundRequired = (value: number, step: number): number => {
  if (!Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
};

const normalizeDailyPaceComposition = (
  meta: DevicePlan['meta'],
): Pick<DevicePlan['meta'], 'dailySoftLimitKw' | 'budgetPaceKw' | 'projectedExemptKw'> => {
  const dailySoftLimitKw = roundOptionalNullable(meta.dailySoftLimitKw, PLAN_META_KW_STEP);
  const projectedExemptKw = roundOptionalNullable(meta.projectedExemptKw, PLAN_META_KW_STEP);
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
      : roundOptionalNullable(meta.budgetPaceKw, PLAN_META_KW_STEP),
    projectedExemptKw,
  };
};

export const normalizePlanMeta = (meta: DevicePlan['meta']): DevicePlan['meta'] => {
  const dailyPaceComposition = normalizeDailyPaceComposition(meta);
  return {
    ...meta,
    totalKw: roundNullable(meta.totalKw, PLAN_META_KW_STEP),
    softLimitKw: roundOptional(meta.softLimitKw, PLAN_META_KW_STEP) ?? meta.softLimitKw,
    capacitySoftLimitKw: roundOptional(meta.capacitySoftLimitKw, PLAN_META_KW_STEP),
    ...dailyPaceComposition,
    headroomKw: roundRequired(meta.headroomKw, PLAN_META_KW_STEP),
    shortfallBudgetThresholdKw: roundOptional(meta.shortfallBudgetThresholdKw, PLAN_META_KW_STEP),
    shortfallBudgetHeadroomKw: roundOptionalNullable(meta.shortfallBudgetHeadroomKw, PLAN_META_KW_STEP),
    hardCapLimitKw: roundOptionalNullable(meta.hardCapLimitKw, PLAN_META_KW_STEP),
    hardCapHeadroomKw: roundOptionalNullable(meta.hardCapHeadroomKw, PLAN_META_KW_STEP),
    usedKWh: roundOptional(meta.usedKWh, PLAN_META_KWH_STEP),
    budgetKWh: roundOptional(meta.budgetKWh, PLAN_META_KWH_STEP),
    capacityLimitKw: roundOptional(meta.capacityLimitKw, PLAN_META_KW_STEP),
    minutesRemaining: normalizeMinutesRemaining(meta.minutesRemaining),
    controlledKw: roundOptional(meta.controlledKw, PLAN_META_KW_STEP),
    uncontrolledKw: roundOptional(meta.uncontrolledKw, PLAN_META_KW_STEP),
    hourControlledKWh: roundOptional(meta.hourControlledKWh, PLAN_META_KWH_STEP),
    hourUncontrolledKWh: roundOptional(meta.hourUncontrolledKWh, PLAN_META_KWH_STEP),
    dailyBudgetRemainingKWh: roundOptional(meta.dailyBudgetRemainingKWh, PLAN_META_KWH_STEP),
    dailyBudgetHourKWh: roundOptional(meta.dailyBudgetHourKWh, PLAN_META_KWH_STEP),
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
    headroomKw: roundRequired(status.headroomKw, PLAN_META_KW_STEP),
    hourlyLimitKw: roundOptional(status.hourlyLimitKw, PLAN_META_KW_STEP),
    hourlyUsageKwh: roundOptional(status.hourlyUsageKwh, PLAN_META_KWH_STEP) ?? status.hourlyUsageKwh,
    dailyBudgetRemainingKwh: roundOptional(status.dailyBudgetRemainingKwh, PLAN_META_KWH_STEP),
    shortfallBudgetThresholdKw: roundOptional(status.shortfallBudgetThresholdKw, PLAN_META_KW_STEP),
    shortfallBudgetHeadroomKw: roundOptionalNullable(status.shortfallBudgetHeadroomKw, PLAN_META_KW_STEP),
    hardCapHeadroomKw: roundOptionalNullable(status.hardCapHeadroomKw, PLAN_META_KW_STEP),
    totalKw: roundOptional(status.totalKw, PLAN_META_KW_STEP),
    controlledKw: roundOptional(status.controlledKw, PLAN_META_KW_STEP),
    uncontrolledKw: roundOptional(status.uncontrolledKw, PLAN_META_KW_STEP),
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
