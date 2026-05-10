import type { SettingsUiBootstrap, SettingsUiPricesPayload } from '../../../contracts/src/settingsUiApi.ts';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';

export const ONE_HOUR_MS = 60 * 60 * 1000;

const isRecord = (candidate: unknown): candidate is Record<string, unknown> => (
  Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
);

export const isFiniteNumber = (candidate: unknown): candidate is number => (
  typeof candidate === 'number' && Number.isFinite(candidate)
);

type PriceEntryLike = {
  startsAt: string;
  total: number;
  isCheap?: boolean;
  isExpensive?: boolean;
};

type CombinedPricesLike = {
  prices?: unknown;
  days?: unknown;
};

export type HorizonHour = {
  startsAtMs: number;
  endMs: number;
  price: number;
  isCheap?: boolean;
  isExpensive?: boolean;
  plannedOtherKWh: number;
};

const getCombinedPrices = (payload: SettingsUiPricesPayload): PriceEntryLike[] => {
  const combined = payload.combinedPrices as CombinedPricesLike | unknown[] | null;
  let entries: unknown[] = [];
  if (Array.isArray(combined)) {
    entries = combined;
  } else if (combined && typeof combined === 'object') {
    const days = (combined as CombinedPricesLike).days;
    if (days && typeof days === 'object' && !Array.isArray(days)) {
      entries = Object.values(days as Record<string, unknown>).flatMap((day) => (
        day && typeof day === 'object' && Array.isArray((day as { hours?: unknown }).hours)
          ? ((day as { hours: unknown[] }).hours)
          : []
      ));
    } else if (Array.isArray((combined as CombinedPricesLike).prices)) {
      entries = (combined as CombinedPricesLike).prices as unknown[];
    }
  }
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.startsAt !== 'string') return [];
    let total: number | null = null;
    if (isFiniteNumber(entry.total)) total = entry.total;
    else if (isFiniteNumber(entry.totalPrice)) total = entry.totalPrice;
    if (!isFiniteNumber(total)) return [];
    return [{
      startsAt: entry.startsAt,
      total,
      ...(entry.isCheap === true ? { isCheap: true } : {}),
      ...(entry.isExpensive === true ? { isExpensive: true } : {}),
    }];
  });
};

const getDailyBudgetDayByBucket = (
  dailyBudget: DailyBudgetUiPayload | null,
  startMs: number,
): { day: DailyBudgetDayPayload; index: number } | null => {
  if (!dailyBudget) return null;
  for (const day of Object.values(dailyBudget.days)) {
    const index = day.buckets.startUtc.findIndex((startUtc) => new Date(startUtc).getTime() === startMs);
    if (index >= 0) return { day, index };
  }
  return null;
};

const resolvePlannedOtherKWh = (
  dailyBudget: DailyBudgetUiPayload | null,
  startMs: number,
  device: TargetDeviceSnapshot,
): number => {
  const match = getDailyBudgetDayByBucket(dailyBudget, startMs);
  if (!match) return 0;
  const uncontrolled = match.day.buckets.plannedUncontrolledKWh?.[match.index];
  const controlled = match.day.buckets.plannedControlledKWh?.[match.index];
  const fallback = match.day.buckets.plannedKWh[match.index];
  if (device.priority === 1 && isFiniteNumber(uncontrolled)) {
    return Math.max(0, uncontrolled);
  }
  const planned = (
    (isFiniteNumber(uncontrolled) ? uncontrolled : 0)
    + (isFiniteNumber(controlled) ? controlled : 0)
  );
  if (planned > 0) return planned;
  return isFiniteNumber(fallback) ? fallback : 0;
};

export const collectHorizonHours = (params: {
  bootstrap: SettingsUiBootstrap;
  deadlineAtMs: number;
  device: TargetDeviceSnapshot;
  // Hours older than this point are dropped so the chart does not render
  // unrelated history. The runtime planner is the source of truth for the
  // active plan; for a known active plan, callers pass the plan's `startedAtMs`
  // (or `original.revisedAtMs`) so the chart can include past hours within the
  // plan's lifetime. Without an active plan, callers pass `nowMs`.
  windowStartMs: number;
  prices: SettingsUiPricesPayload;
}): HorizonHour[] => (
  getCombinedPrices(params.prices)
    .map((price) => ({ price, startsAtMs: new Date(price.startsAt).getTime() }))
    .filter(({ startsAtMs }) => Number.isFinite(startsAtMs))
    .map(({ price, startsAtMs }) => ({
      startsAtMs,
      endMs: startsAtMs + ONE_HOUR_MS,
      price: price.total,
      isCheap: price.isCheap,
      isExpensive: price.isExpensive,
      plannedOtherKWh: resolvePlannedOtherKWh(params.bootstrap.dailyBudget, startsAtMs, params.device),
    }))
    .filter((hour) => hour.endMs > params.windowStartMs && hour.startsAtMs < params.deadlineAtMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
);
