import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';
const STEPS_PER_DAY = 24;
const DEFAULT_EPSILON = 1e-6;
const PREVIOUS_DAY_PROBE_HOURS = 26;
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
const hasFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);
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
  if (hasFiniteNumber(options.max) && value > options.max) return null;
  return value;
};
const parsePriceEntry = (entry: unknown): ParsedPriceEntry | null => {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const startsAtRaw = record.startsAt;
  if (typeof startsAtRaw !== 'string' || !startsAtRaw.trim()) return null;
  const startsAtMs = Date.parse(startsAtRaw);
  if (!Number.isFinite(startsAtMs)) return null;
  let totalPriceRaw: number | null = null;
  if (hasFiniteNumber(record.totalPrice)) {
    totalPriceRaw = record.totalPrice;
  } else if (hasFiniteNumber(record.total)) {
    totalPriceRaw = record.total;
  }
  if (!hasFiniteNumber(totalPriceRaw)) return null;
  return {
    startsAtMs,
    price: totalPriceRaw,
  };
};
const normalizeCombinedEntries = (combinedPrices: unknown): ParsedPriceEntry[] => {
  let maybeArray: unknown[] = [];
  if (Array.isArray(combinedPrices)) {
    maybeArray = combinedPrices;
  } else if (
    combinedPrices
    && typeof combinedPrices === 'object'
    && Array.isArray((combinedPrices as Record<string, unknown>).prices)
  ) {
    maybeArray = (combinedPrices as Record<string, unknown>).prices as unknown[];
  }
  return maybeArray
    .map((entry) => parsePriceEntry(entry))
    .filter((entry): entry is ParsedPriceEntry => entry !== null)
    .sort((a, b) => a.startsAtMs - b.startsAtMs);
};
const buildSlotIndex = (
  entries: ParsedPriceEntry[],
  timeZone: string,
): DayHourSlotIndex => {
  const grouped = new Map<string, Map<number, HourSlot[]>>();
  for (const entry of entries) {
    const slotDate = new Date(entry.startsAtMs);
    const slotParts = getZonedParts(slotDate, timeZone);
    const dateKey = [
      slotParts.year.toString().padStart(4, '0'),
      slotParts.month.toString().padStart(2, '0'),
      slotParts.day.toString().padStart(2, '0'),
    ].join('-');
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
  const indexed = new Map<string, Map<number, HourSlot[]>>();
  for (const [dateKey, dayMap] of grouped.entries()) {
    const compactDayMap = new Map<number, HourSlot[]>();
    for (const [hour, hourList] of dayMap.entries()) {
      const sorted = [...hourList].sort((a, b) => a.startsAtMs - b.startsAtMs);
      if (sorted.length === 0) continue;
      compactDayMap.set(hour, sorted);
    }
    indexed.set(dateKey, compactDayMap);
  }
  return indexed;
};
const buildEvaluationContext = (params: {
  combinedPrices: unknown;
  timeZone: string;
  now: Date;
}): EvaluationContext => {
  const { combinedPrices, timeZone, now } = params;
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
const evaluateLowestRank = (params: {
  prices: number[];
  currentPrice: number;
  number: number;
  epsilon?: number;
}): { matches: boolean; cutoff: number; candidateCount: number } | null => {
  const { prices, currentPrice, number } = params;
  const epsilon = hasFiniteNumber(params.epsilon) ? params.epsilon : DEFAULT_EPSILON;
  const finitePrices = prices.filter((price) => Number.isFinite(price));
  if (finitePrices.length === 0) return null;
  const rankCount = Math.max(1, Math.min(Math.trunc(number), finitePrices.length));
  const sorted = [...finitePrices].sort((a, b) => a - b);
  const cutoff = sorted[rankCount - 1];
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
  let dayStartUtcMs = getDateKeyStartMs(context.todayKey, context.timeZone);
  if (offset > 0) {
    for (let index = 0; index < offset; index += 1) {
      dayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, context.timeZone);
    }
  }
  if (offset < 0) {
    for (let index = 0; index < Math.abs(offset); index += 1) {
      const previousProbe = new Date(dayStartUtcMs - PREVIOUS_DAY_PROBE_HOURS * 60 * 60 * 1000);
      const previousKey = getDateKeyInTimeZone(previousProbe, context.timeZone);
      dayStartUtcMs = getDateKeyStartMs(previousKey, context.timeZone);
    }
  }
  const dateKey = getDateKeyInTimeZone(new Date(dayStartUtcMs), context.timeZone);
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
  const sorted = [...hourSlots].sort((a, b) => a.startsAtMs - b.startsAtMs);
  const active = [...sorted].reverse().find((slot) => slot.startsAtMs <= nowMs);
  return active ?? null;
};
const selectWindowSlot = (params: {
  hourSlots: HourSlot[];
  dayOffset: number;
  localHour: number;
  currentHour: number;
  nowMs: number;
}): HourSlot | null => {
  const { hourSlots, dayOffset, localHour, currentHour, nowMs } = params;
  if (hourSlots.length === 0) return null;
  const sorted = [...hourSlots].sort((a, b) => a.startsAtMs - b.startsAtMs);
  if (dayOffset === 0 && localHour === currentHour) return selectCurrentHourSlot(sorted, nowMs);
  if (dayOffset < 0) return sorted[sorted.length - 1];
  if (dayOffset > 0) return sorted[0];
  if (localHour < currentHour) return sorted[sorted.length - 1];
  return sorted[0];
};
const evaluateLowestToday = (
  args: unknown,
  context: EvaluationContext,
  currentPriceOverride: number | undefined,
  epsilon?: number,
): LowestPriceEvaluationResult => {
  const number = getPositiveIntegerArg(args, 'number', { min: 1, max: STEPS_PER_DAY });
  if (!number) {
    return {
      matches: false,
      reason: 'invalid_args',
      currentPrice: null,
      cutoff: null,
      candidateCount: 0,
    };
  }
  const daySlots = getDaySlots(context, context.todayKey);
  if (daySlots.length === 0) {
    return {
      matches: false,
      reason: 'missing_day_slots',
      currentPrice: null,
      cutoff: null,
      candidateCount: 0,
    };
  }
  const expectedHours = getExpectedIndexedHoursForDay(context.todayKey, context.timeZone);
  if (daySlots.length < expectedHours) {
    return {
      matches: false,
      reason: 'incomplete_day_slots',
      currentPrice: null,
      cutoff: null,
      candidateCount: daySlots.length,
    };
  }
  let currentPrice: number | null = null;
  if (hasFiniteNumber(currentPriceOverride)) {
    currentPrice = currentPriceOverride;
  } else {
    const currentHourSlots = context.slotsByDateHour.get(context.todayKey)?.get(context.currentHour) ?? [];
    const currentSlot = selectCurrentHourSlot(currentHourSlots, context.nowMs);
    if (!currentSlot) {
      return {
        matches: false,
        reason: 'missing_current_slot',
        currentPrice: null,
        cutoff: null,
        candidateCount: daySlots.length,
      };
    }
    currentPrice = currentSlot.price;
  }
  if (!hasFiniteNumber(currentPrice)) {
    return {
      matches: false,
      reason: 'missing_current_slot',
      currentPrice: null,
      cutoff: null,
      candidateCount: daySlots.length,
    };
  }
  const evaluation = evaluateLowestRank({
    prices: daySlots.map((slot) => slot.price),
    currentPrice,
    number,
    epsilon,
  });
  if (!evaluation) {
    return {
      matches: false,
      reason: 'missing_day_slots',
      currentPrice,
      cutoff: null,
      candidateCount: daySlots.length,
    };
  }
  return {
    matches: evaluation.matches,
    reason: 'ok',
    currentPrice,
    cutoff: evaluation.cutoff,
    candidateCount: evaluation.candidateCount,
  };
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
const collectBeforeWindowPrices = (params: {
  context: EvaluationContext;
  currentStep: number;
  startStep: number;
  endStep: number;
  currentPriceOverride: number | undefined;
}): {
  prices: number[];
  currentPrice: number | null;
  error: LowestPriceEvaluationResult | null;
} => {
  const { context, currentStep, startStep, endStep, currentPriceOverride } = params;
  const dateOffsetCache = new Map<number, string>();
  let prices: number[] = [];
  let currentPrice: number | null = hasFiniteNumber(currentPriceOverride) ? currentPriceOverride : null;
  for (let step = startStep; step < endStep; step += 1) {
    const dayOffset = floorDiv(step, STEPS_PER_DAY);
    const localHour = normalizeStep(step);
    const dateKey = getDateKeyForDayOffset(dayOffset, context, dateOffsetCache);
    const hourSlots = context.slotsByDateHour.get(dateKey)?.get(localHour) ?? [];
    const slot = selectWindowSlot({
      hourSlots,
      dayOffset,
      localHour,
      currentHour: currentStep,
      nowMs: context.nowMs,
    });
    if (!slot) {
      const isCurrentStep = dayOffset === 0 && localHour === currentStep;
      if (isCurrentStep && hasFiniteNumber(currentPriceOverride)) {
        prices = [...prices, currentPriceOverride];
        currentPrice = currentPriceOverride;
        continue;
      }
      return {
        prices,
        currentPrice,
        error: {
          matches: false,
          reason: 'missing_window_slot',
          currentPrice,
          cutoff: null,
          candidateCount: prices.length,
        },
      };
    }
    prices = [...prices, slot.price];
    if (!hasFiniteNumber(currentPrice) && dayOffset === 0 && localHour === currentStep) {
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
  if (!parsedArgs) {
    return {
      matches: false,
      reason: 'invalid_args',
      currentPrice: null,
      cutoff: null,
      candidateCount: 0,
    };
  }
  const currentStep = context.currentHour;
  const bounds = getBeforeWindowBounds(currentStep, parsedArgs.time, parsedArgs.period);
  if (!bounds) {
    return {
      matches: false,
      reason: 'outside_window',
      currentPrice: null,
      cutoff: null,
      candidateCount: 0,
    };
  }
  const collected = collectBeforeWindowPrices({
    context,
    currentStep,
    startStep: bounds.startStep,
    endStep: bounds.endStep,
    currentPriceOverride,
  });
  if (collected.error) return collected.error;
  const { prices, currentPrice } = collected;
  if (!hasFiniteNumber(currentPrice)) {
    return {
      matches: false,
      reason: 'missing_current_slot',
      currentPrice: null,
      cutoff: null,
      candidateCount: prices.length,
    };
  }
  const evaluation = evaluateLowestRank({
    prices,
    currentPrice,
    number: parsedArgs.number,
    epsilon,
  });
  if (!evaluation) {
    return {
      matches: false,
      reason: 'missing_window_slot',
      currentPrice,
      cutoff: null,
      candidateCount: prices.length,
    };
  }
  return {
    matches: evaluation.matches,
    reason: 'ok',
    currentPrice,
    cutoff: evaluation.cutoff,
    candidateCount: evaluation.candidateCount,
  };
};
export function evaluateLowestPriceCard(params: {
  cardId: LowestPriceCardId;
  args: unknown;
  combinedPrices: unknown;
  timeZone: string;
  now: Date;
  currentPriceOverride?: number;
  epsilon?: number;
}): LowestPriceEvaluationResult {
  const context = buildEvaluationContext({
    combinedPrices: params.combinedPrices,
    timeZone: params.timeZone,
    now: params.now,
  });
  if (params.cardId === 'price_lowest_today') {
    return evaluateLowestToday(params.args, context, params.currentPriceOverride, params.epsilon);
  }
  return evaluateLowestBefore(params.args, context, params.currentPriceOverride, params.epsilon);
}
export function resolveCurrentPriceFromCombined(params: {
  combinedPrices: unknown;
  timeZone: string;
  now: Date;
}): { currentPrice: number | null; reason: 'ok' | 'missing_current_slot' } {
  const context = buildEvaluationContext({
    combinedPrices: params.combinedPrices,
    timeZone: params.timeZone,
    now: params.now,
  });
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
