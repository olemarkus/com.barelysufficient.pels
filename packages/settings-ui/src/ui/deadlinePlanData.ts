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
  } else if (Array.isArray((combined as CombinedPricesLike | null)?.prices)) {
    entries = (combined as CombinedPricesLike).prices as unknown[];
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
  nowMs: number;
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
    .filter((hour) => hour.endMs > params.nowMs && hour.startsAtMs < params.deadlineAtMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
);

export const allocateChargeHours = (params: {
  energyNeededKWh: number;
  hours: HorizonHour[];
  nowMs: number;
  usefulPowerKw: number;
}): Map<number, number> => {
  let remainingKWh = Math.max(0, params.energyNeededKWh);
  const allocation = new Map<number, number>();
  const candidates = params.hours
    .map((hour) => {
      const durationHours = Math.max(0, (hour.endMs - Math.max(hour.startsAtMs, params.nowMs)) / ONE_HOUR_MS);
      return { hour, capacityKWh: durationHours * params.usefulPowerKw };
    })
    .filter((candidate) => candidate.capacityKWh > 0)
    .sort((left, right) => left.hour.price - right.hour.price || left.hour.startsAtMs - right.hour.startsAtMs);

  for (const candidate of candidates) {
    if (remainingKWh <= 0.001) break;
    const allocated = Math.min(remainingKWh, candidate.capacityKWh);
    allocation.set(candidate.hour.startsAtMs, allocated);
    remainingKWh -= allocated;
  }
  return allocation;
};
