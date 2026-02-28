import { buildPelsStatus } from '../core/pelsStatus';
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

export const normalizePlanMeta = (meta: DevicePlan['meta']): DevicePlan['meta'] => ({
  ...meta,
  totalKw: roundNullable(meta.totalKw, PLAN_META_KW_STEP),
  softLimitKw: roundOptional(meta.softLimitKw, PLAN_META_KW_STEP) ?? meta.softLimitKw,
  capacitySoftLimitKw: roundOptional(meta.capacitySoftLimitKw, PLAN_META_KW_STEP),
  dailySoftLimitKw: roundOptionalNullable(meta.dailySoftLimitKw, PLAN_META_KW_STEP),
  headroomKw: roundNullable(meta.headroomKw, PLAN_META_KW_STEP),
  usedKWh: roundOptional(meta.usedKWh, PLAN_META_KWH_STEP),
  budgetKWh: roundOptional(meta.budgetKWh, PLAN_META_KWH_STEP),
  minutesRemaining: normalizeMinutesRemaining(meta.minutesRemaining),
  controlledKw: roundOptional(meta.controlledKw, PLAN_META_KW_STEP),
  uncontrolledKw: roundOptional(meta.uncontrolledKw, PLAN_META_KW_STEP),
  hourControlledKWh: roundOptional(meta.hourControlledKWh, PLAN_META_KWH_STEP),
  hourUncontrolledKWh: roundOptional(meta.hourUncontrolledKWh, PLAN_META_KWH_STEP),
  dailyBudgetRemainingKWh: roundOptional(meta.dailyBudgetRemainingKWh, PLAN_META_KWH_STEP),
  dailyBudgetHourKWh: roundOptional(meta.dailyBudgetHourKWh, PLAN_META_KWH_STEP),
});

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
    headroomKw: roundNullable(status.headroomKw, PLAN_META_KW_STEP),
    hourlyLimitKw: roundOptional(status.hourlyLimitKw, PLAN_META_KW_STEP),
    hourlyUsageKwh: roundOptional(status.hourlyUsageKwh, PLAN_META_KWH_STEP) ?? status.hourlyUsageKwh,
    dailyBudgetRemainingKwh: roundOptional(status.dailyBudgetRemainingKwh, PLAN_META_KWH_STEP),
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
  const record = value as { prices?: unknown };
  return Array.isArray(record.prices) && record.prices.length > 0;
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

export const buildPelsStatusInputKey = (params: {
  changes?: PlanStatusInputChanges;
  isCheap: boolean;
  isExpensive: boolean;
  combinedPrices: unknown;
  lastPowerUpdate: number | null;
}): string => {
  const { changes, isCheap, isExpensive, combinedPrices, lastPowerUpdate } = params;
  const actionSignature = changes?.actionSignature ?? '';
  const detailSignature = changes?.detailSignature ?? '';
  const metaSignature = changes?.metaSignature ?? '';
  const priceKey = resolveStatusPriceKey({ isCheap, isExpensive, combinedPrices });
  const lastPowerUpdateKey = lastPowerUpdate === null ? 'null' : String(lastPowerUpdate);
  return `${actionSignature}|${detailSignature}|${metaSignature}|${priceKey}|${lastPowerUpdateKey}`;
};
