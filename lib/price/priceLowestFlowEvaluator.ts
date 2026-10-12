import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  shiftDateKey,
  getZonedParts,
} from '../../packages/shared-domain/src/utils/dateUtils';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import type { CombinedHourlyPrice } from './priceTypes';
const STEPS_PER_DAY = 24;
const DEFAULT_EPSILON = 1e-6;
type ParsedPriceEntry = {
  startsAtMs: number;
  price: number;
};
type HourSlot = {
  dateKey: string;
  hour: number;
  startsAtMs: number;
  price: number;
};
type DayHourSlotIndex = Map<string, Map<number, HourSlot[]>>;
type EvaluationContext = {
  nowMs: number;
  timeZone: string;
  todayKey: string;
  currentHour: number;
  slotsByDateHour: DayHourSlotIndex;
};
export type LowestPriceCardId = 'price_lowest_before' | 'price_lowest_today';
export type LowestPriceEvaluationResult = {
  matches: boolean;
  reason:
  | 'ok'
  | 'invalid_args'
  | 'missing_current_slot'
  | 'missing_day_slots'
  | 'incomplete_day_slots'
  | 'outside_window'
  | 'missing_window_slot';
  currentPrice: number | null;
  cutoff: number | null;
  candidateCount: number;
};
// A card that cannot answer: no cutoff to report.
const noMatch = (
  reason: Exclude<LowestPriceEvaluationResult['reason'], 'ok'>,
  currentPrice: number | null,
  candidateCount: number,
): LowestPriceEvaluationResult => ({ matches: false, reason, currentPrice, cutoff: null, candidateCount });
const floorDiv = (value: number, divisor: number): number => Math.floor(value / divisor);
const normalizeStep = (step: number): number => ((step % STEPS_PER_DAY) + STEPS_PER_DAY) % STEPS_PER_DAY;
const getPositiveIntegerArg = (
  args: unknown,
  key: string,
  options: { min: number; max?: number },
): number | null => {
  if (!args || typeof args !== 'object') return null;
  const valueRaw = (args as Record<string, unknown>)[key];
  const valueNum = Number(valueRaw);
  if (!Number.isFinite(valueNum)) return null;
  const value = Math.trunc(valueNum);
  if (!Number.isFinite(value) || value < options.min) return null;
  if (isFiniteNumber(options.max) && value > options.max) return null;
  return value;
};
const normalizeCombinedEntries = (combinedPrices: readonly CombinedHourlyPrice[]): ParsedPriceEntry[] => (
  [...combinedPrices.flatMap((entry) => {
    const startsAtMs = Date.parse(entry.startsAt);
    if (!Number.isFinite(startsAtMs) || !Number.isFinite(entry.totalPrice)) return [];
    return [{ startsAtMs, price: entry.totalPrice }];
  })].sort((a, b) => a.startsAtMs - b.startsAtMs)
);
const buildSlotIndex = (
  entries: ParsedPriceEntry[],
  timeZone: string,
): DayHourSlotIndex => {
  const grouped = new Map<string, Map<number, HourSlot[]>>();
  for (const entry of entries) {
    const slotDate = new Date(entry.startsAtMs);
    const slotParts = getZonedParts(slotDate, timeZone);
    const dateKey = getDateKeyInTimeZone(slotDate, timeZone);
    const dayMap = grouped.get(dateKey) ?? new Map<number, HourSlot[]>();
    const currentHourList = dayMap.get(slotParts.hour) ?? [];
    const hourList = [...currentHourList, {
      dateKey,
      hour: slotParts.hour,
      startsAtMs: entry.startsAtMs,
      price: entry.price,
    }];
    dayMap.set(slotParts.hour, hourList);
    grouped.set(dateKey, dayMap);
  }
  // Entries are sorted before grouping, so each hour retains chronological order,
  // including the two instants of a repeated DST hour.
  return grouped;
};
const buildEvaluationContext = (
  combinedPrices: readonly CombinedHourlyPrice[],
  timeZone: string,
  now: Date,
): EvaluationContext => {
  const entries = normalizeCombinedEntries(combinedPrices);
  const nowMs = now.getTime();
  const nowParts = getZonedParts(now, timeZone);
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  return {
    nowMs,
    timeZone,
    todayKey,
    currentHour: nowParts.hour,
    slotsByDateHour: buildSlotIndex(entries, timeZone),
  };
};
const getExpectedIndexedHoursForDay = (dateKey: string, timeZone: string): number => {
  const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const localDayHours = Math.round((nextDayStartUtcMs - dayStartUtcMs) / (60 * 60 * 1000));
  return Math.max(0, localDayHours);
};
const evaluateLowestRank = (
  prices: number[],
  currentPrice: number,
  number: number,
  epsilonOverride: number | undefined,
): { matches: boolean; cutoff: number; candidateCount: number } | null => {
  const epsilon = isFiniteNumber(epsilonOverride) ? epsilonOverride : DEFAULT_EPSILON;
  const finitePrices = prices.filter((price) => Number.isFinite(price));
  if (finitePrices.length === 0) return null;
  const rankCount = Math.max(1, Math.min(Math.trunc(number), finitePrices.length));
  const sorted = [...finitePrices].sort((a, b) => a - b);
  const cutoff = sorted[rankCount - 1];
  // `rankCount` is clamped into the sorted range above; with no cutoff there is
  // no rank to compare the current price against.
  if (cutoff === undefined) return null;
  return {
    matches: currentPrice <= cutoff + epsilon,
    cutoff,
    candidateCount: finitePrices.length,
  };
};
const getDateKeyForDayOffset = (
  offset: number,
  context: EvaluationContext,
  cache: Map<number, string>,
): string => {
  const cached = cache.get(offset);
  if (cached) return cached;
  const dateKey = shiftDateKey(context.todayKey, offset);
  cache.set(offset, dateKey);
  return dateKey;
};
const getDaySlots = (context: EvaluationContext, dateKey: string): HourSlot[] => {
  const dayMap = context.slotsByDateHour.get(dateKey);
  if (!dayMap) return [];
  let daySlots: HourSlot[] = [];
  for (const hourSlots of dayMap.values()) {
    daySlots = [...daySlots, ...hourSlots];
  }
  return [...daySlots].sort((a, b) => a.startsAtMs - b.startsAtMs);
};
const selectCurrentHourSlot = (hourSlots: HourSlot[], nowMs: number): HourSlot | null => {
  if (hourSlots.length === 0) return null;
  const active = [...hourSlots].reverse().find((slot) => slot.startsAtMs <= nowMs);
  return active ?? null;
};
const selectWindowSlot = (
  hourSlots: HourSlot[],
  dayOffset: number,
  localHour: number,
  context: EvaluationContext,
): HourSlot | null => {
  const { currentHour, nowMs } = context;
  if (hourSlots.length === 0) return null;
  if (dayOffset === 0 && localHour === currentHour) return selectCurrentHourSlot(hourSlots, nowMs);
  if (dayOffset < 0) return hourSlots.at(-1) ?? null;
  if (dayOffset > 0) return hourSlots[0] ?? null;
  if (localHour < currentHour) return hourSlots.at(-1) ?? null;
  return hourSlots[0] ?? null;
};
const evaluateLowestToday = (
  args: unknown,
  context: EvaluationContext,
  currentPriceOverride: number | undefined,
  epsilon?: number,
): LowestPriceEvaluationResult => {
  const number = getPositiveIntegerArg(args, 'number', { min: 1, max: STEPS_PER_DAY });
  if (!number) return noMatch('invalid_args', null, 0);
  const daySlots = getDaySlots(context, context.todayKey);
  if (daySlots.length === 0) return noMatch('missing_day_slots', null, 0);
  const expectedHours = getExpectedIndexedHoursForDay(context.todayKey, context.timeZone);
  if (daySlots.length < expectedHours) return noMatch('incomplete_day_slots', null, daySlots.length);
  const currentPrice = isFiniteNumber(currentPriceOverride)
    ? currentPriceOverride
    : (() => {
      const currentHourSlots = context.slotsByDateHour.get(context.todayKey)?.get(context.currentHour) ?? [];
      const currentSlot = selectCurrentHourSlot(currentHourSlots, context.nowMs);
      if (!currentSlot) return null;
      return currentSlot.price;
    })();
  if (!isFiniteNumber(currentPrice)) return noMatch('missing_current_slot', null, daySlots.length);
  const evaluation = evaluateLowestRank(daySlots.map((slot) => slot.price), currentPrice, number, epsilon);
  if (!evaluation) return noMatch('missing_day_slots', currentPrice, daySlots.length);
  return { ...evaluation, reason: 'ok', currentPrice };
};
type LowestBeforeArgs = {
  period: number;
  number: number;
  time: number;
};
const parseLowestBeforeArgs = (args: unknown): LowestBeforeArgs | null => {
  const period = getPositiveIntegerArg(args, 'period', { min: 2, max: STEPS_PER_DAY - 1 });
  const number = getPositiveIntegerArg(args, 'number', { min: 1, max: STEPS_PER_DAY });
  const time = getPositiveIntegerArg(args, 'time', { min: 1, max: 24 });
  if (!period || !number || !time) return null;
  return { period, number, time };
};
const getBeforeWindowBounds = (
  currentStep: number,
  time: number,
  period: number,
): { startStep: number; endStep: number } | null => {
  let endStep = time;
  if (endStep < currentStep) endStep += STEPS_PER_DAY;
  const startStep = endStep - period;
  if ((currentStep >= endStep) || (currentStep < startStep)) return null;
  return { startStep, endStep };
};
const collectBeforeWindowPrices = (
  context: EvaluationContext,
  bounds: { startStep: number; endStep: number },
  currentPriceOverride: number | undefined,
): {
  prices: number[];
  currentPrice: number | null;
  error: LowestPriceEvaluationResult | null;
} => {
  const { startStep, endStep } = bounds;
  const currentStep = context.currentHour;
  const dateOffsetCache = new Map<number, string>();
  let prices: number[] = [];
  let currentPrice: number | null = isFiniteNumber(currentPriceOverride) ? currentPriceOverride : null;
  for (let step = startStep; step < endStep; step += 1) {
    const dayOffset = floorDiv(step, STEPS_PER_DAY);
    const localHour = normalizeStep(step);
    const dateKey = getDateKeyForDayOffset(dayOffset, context, dateOffsetCache);
    const hourSlots = context.slotsByDateHour.get(dateKey)?.get(localHour) ?? [];
    const slot = selectWindowSlot(hourSlots, dayOffset, localHour, context);
    if (!slot) {
      const isCurrentStep = dayOffset === 0 && localHour === currentStep;
      if (isCurrentStep && isFiniteNumber(currentPriceOverride)) {
        prices = [...prices, currentPriceOverride];
        currentPrice = currentPriceOverride;
        continue;
      }
      return {
        prices,
        currentPrice,
        error: noMatch('missing_window_slot', currentPrice, prices.length),
      };
    }
    prices = [...prices, slot.price];
    if (!isFiniteNumber(currentPrice) && dayOffset === 0 && localHour === currentStep) {
      currentPrice = slot.price;
    }
  }
  return { prices, currentPrice, error: null };
};
const evaluateLowestBefore = (
  args: unknown,
  context: EvaluationContext,
  currentPriceOverride: number | undefined,
  epsilon?: number,
): LowestPriceEvaluationResult => {
  const parsedArgs = parseLowestBeforeArgs(args);
  if (!parsedArgs) return noMatch('invalid_args', null, 0);
  const bounds = getBeforeWindowBounds(context.currentHour, parsedArgs.time, parsedArgs.period);
  if (!bounds) return noMatch('outside_window', null, 0);
  const collected = collectBeforeWindowPrices(context, bounds, currentPriceOverride);
  if (collected.error) return collected.error;
  const { prices, currentPrice } = collected;
  if (!isFiniteNumber(currentPrice)) return noMatch('missing_current_slot', null, prices.length);
  const evaluation = evaluateLowestRank(prices, currentPrice, parsedArgs.number, epsilon);
  if (!evaluation) return noMatch('missing_window_slot', currentPrice, prices.length);
  return { ...evaluation, reason: 'ok', currentPrice };
};
export function evaluateLowestPriceCard(params: {
  cardId: LowestPriceCardId;
  args: unknown;
  combinedPrices: readonly CombinedHourlyPrice[];
  timeZone: string;
  now: Date;
  currentPriceOverride?: number;
  epsilon?: number;
}): LowestPriceEvaluationResult {
  const context = buildEvaluationContext(params.combinedPrices, params.timeZone, params.now);
  if (params.cardId === 'price_lowest_today') {
    return evaluateLowestToday(params.args, context, params.currentPriceOverride, params.epsilon);
  }
  return evaluateLowestBefore(params.args, context, params.currentPriceOverride, params.epsilon);
}
export function resolveCurrentPriceFromCombined(params: {
  combinedPrices: readonly CombinedHourlyPrice[];
  timeZone: string;
  now: Date;
}): { currentPrice: number | null; reason: 'ok' | 'missing_current_slot' } {
  const context = buildEvaluationContext(params.combinedPrices, params.timeZone, params.now);
  const currentHourSlots = context.slotsByDateHour.get(context.todayKey)?.get(context.currentHour) ?? [];
  const current = selectCurrentHourSlot(currentHourSlots, context.nowMs);
  if (!current) {
    return {
      currentPrice: null,
      reason: 'missing_current_slot',
    };
  }
  return {
    currentPrice: current.price,
    reason: 'ok',
  };
}
