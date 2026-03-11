import {
  buildLocalDayBuckets,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';

export type FlowHourlyPrice = {
  startsAt: string;
  totalPrice: number;
};

export type FlowPricePayload = {
  dateKey: string;
  pricesByHour: Record<string, number>;
  updatedAt: string;
  pricesBySlot?: FlowHourlyPrice[];
};

type FlowDaySlot = {
  startsAt: string;
  hour: number;
};

type FlowHourValueEntry = {
  hour: number;
  value: number;
};

type ParsedFlowPricePayloadInput = {
  pricesByHour: Record<string, number>;
  pricesBySlot?: FlowHourlyPrice[];
};

const DEFAULT_FLOW_HOURS = Object.freeze(Array.from({ length: 24 }, (_, hour) => hour));

const isValidHour = (hour: number): boolean => Number.isInteger(hour) && hour >= 0 && hour <= 23;

const normalizeNumeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const pushHourValue = (
  target: FlowHourValueEntry[],
  hour: number,
  value: unknown,
): FlowHourValueEntry[] => {
  if (!isValidHour(hour)) return target;
  const numeric = normalizeNumeric(value);
  if (numeric === null) return target;
  return [...target, { hour, value: numeric }];
};

const buildHourValueEntries = (input: unknown): FlowHourValueEntry[] => {
  if (Array.isArray(input)) {
    return input.reduce<FlowHourValueEntry[]>((acc, value, hour) => pushHourValue(acc, hour, value), []);
  }
  if (input && typeof input === 'object') {
    return Object.entries(input as Record<string, unknown>).reduce<FlowHourValueEntry[]>(
      (acc, [key, value]) => pushHourValue(acc, Number(key), value),
      [],
    );
  }
  return [];
};

const buildPricesByHourFromEntries = (entries: FlowHourValueEntry[]): Record<string, number> => (
  entries.reduce<Record<string, number>>(
    (acc, entry) => ({ ...acc, [String(entry.hour)]: entry.value }),
    {},
  )
);

const buildPricesByHour = (input: unknown): Record<string, number> => (
  buildPricesByHourFromEntries(buildHourValueEntries(input))
);

const buildPricesByHourFromSlotEntries = (
  entries: FlowHourlyPrice[],
  timeZone: string,
): Record<string, number> => {
  const buckets = entries.reduce<Record<string, { sum: number; count: number }>>((acc, entry) => {
    const timestamp = Date.parse(entry.startsAt);
    if (!Number.isFinite(timestamp)) return acc;
    const hour = getZonedParts(new Date(timestamp), timeZone).hour;
    const key = String(hour);
    const current = acc[key] ?? { sum: 0, count: 0 };
    return {
      ...acc,
      [key]: { sum: current.sum + entry.totalPrice, count: current.count + 1 },
    };
  }, {});

  return Object.entries(buckets).reduce<Record<string, number>>((acc, [hour, bucket]) => {
    if (bucket.count <= 0) return acc;
    return {
      ...acc,
      [hour]: bucket.sum / bucket.count,
    };
  }, {});
};

const normalizeFlowSlotEntries = (input: unknown): FlowHourlyPrice[] => {
  if (!Array.isArray(input)) return [];
  const slotMap = input.reduce<Map<string, number>>((acc, entry) => {
    if (!entry || typeof entry !== 'object') return acc;
    const record = entry as Record<string, unknown>;
    const startsAtRaw = record.startsAt;
    if (typeof startsAtRaw !== 'string' || !startsAtRaw.trim()) return acc;
    const startsAtMs = Date.parse(startsAtRaw);
    if (!Number.isFinite(startsAtMs)) return acc;
    const totalPrice = normalizeNumeric(record.totalPrice ?? record.total);
    if (totalPrice === null) return acc;
    acc.set(new Date(startsAtMs).toISOString(), totalPrice);
    return acc;
  }, new Map<string, number>());

  return Array.from(slotMap.entries())
    .sort(([left], [right]) => Date.parse(left) - Date.parse(right))
    .map(([startsAt, totalPrice]) => ({ startsAt, totalPrice }));
};

const parseFlowPriceRaw = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Price data is empty.');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const normalized = trimmed.replace(/'/g, '"').replace(/,\s*}/g, '}');
    return JSON.parse(normalized);
  }
};

export const buildFlowDaySlots = (dateKey: string, timeZone: string): FlowDaySlot[] => {
  const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs } = buildLocalDayBuckets({ dayStartUtcMs, nextDayStartUtcMs, timeZone });
  return bucketStartUtcMs.map((bucketStart) => ({
    startsAt: new Date(bucketStart).toISOString(),
    hour: getZonedParts(new Date(bucketStart), timeZone).hour,
  }));
};

export const getExpectedFlowHours = (dateKey: string, timeZone: string): number[] => {
  const seen = new Set<number>();
  return buildFlowDaySlots(dateKey, timeZone).reduce<number[]>((hours, slot) => {
    if (seen.has(slot.hour)) return hours;
    seen.add(slot.hour);
    return [...hours, slot.hour];
  }, []);
};

export const parseFlowPricePayloadInput = (
  raw: unknown,
  context: { dateKey: string; timeZone: string },
): ParsedFlowPricePayloadInput => {
  const parsed = parseFlowPriceRaw(raw);
  const daySlots = buildFlowDaySlots(context.dateKey, context.timeZone);

  if (Array.isArray(parsed) && parsed.length === daySlots.length) {
    const pricesBySlot = daySlots.flatMap((slot, index) => {
      const totalPrice = normalizeNumeric(parsed[index]);
      if (totalPrice === null) return [];
      return [{ startsAt: slot.startsAt, totalPrice }];
    });
    const slotPricesByHour = buildPricesByHourFromSlotEntries(pricesBySlot, context.timeZone);
    const pricesByHour = slotPricesByHour;
    if (pricesBySlot.length === 0 && Object.keys(pricesByHour).length === 0) {
      throw new Error('No valid hourly prices found in price data.');
    }
    return {
      pricesByHour,
      pricesBySlot: pricesBySlot.length > 0 ? pricesBySlot : undefined,
    };
  }

  const basePricesByHour = buildPricesByHour(parsed);

  const exactSlotPrices = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
      const totalPrice = normalizeNumeric(value);
      if (totalPrice === null) return [];
      const matchingSlot = daySlots.find((slot) => slot.startsAt === key);
      if (!matchingSlot) return [];
      return [{ startsAt: matchingSlot.startsAt, totalPrice }];
    })
    : [];

  if (exactSlotPrices.length === 0 && Object.keys(basePricesByHour).length === 0) {
    throw new Error('No valid hourly prices found in price data.');
  }

  const slotPricesByHour = buildPricesByHourFromSlotEntries(exactSlotPrices, context.timeZone);
  return {
    pricesByHour: {
      ...basePricesByHour,
      ...slotPricesByHour,
    },
    pricesBySlot: exactSlotPrices.length > 0 ? exactSlotPrices : undefined,
  };
};

export const getFlowPricePayload = (raw: unknown): FlowPricePayload | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as {
    dateKey?: unknown;
    pricesByHour?: unknown;
    pricesBySlot?: unknown;
    updatedAt?: unknown;
  };
  if (typeof record.dateKey !== 'string' || !record.dateKey) return null;
  const pricesByHour = buildPricesByHour(record.pricesByHour);
  const pricesBySlot = normalizeFlowSlotEntries(record.pricesBySlot);
  if (Object.keys(pricesByHour).length === 0 && pricesBySlot.length === 0) return null;
  return {
    dateKey: record.dateKey,
    pricesByHour,
    pricesBySlot: pricesBySlot.length > 0 ? pricesBySlot : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
  };
};

export const getMissingFlowHours = (
  pricesByHour: Record<string, number>,
  expectedHours: readonly number[] = DEFAULT_FLOW_HOURS,
): number[] => (
  [...expectedHours]
    .filter((hour) => !Number.isFinite(pricesByHour[String(hour)]))
);

export const buildFlowEntries = (payload: FlowPricePayload, timeZone: string): FlowHourlyPrice[] => {
  const daySlots = buildFlowDaySlots(payload.dateKey, timeZone);
  const exactSlotPrices = new Map<string, number>(
    normalizeFlowSlotEntries(payload.pricesBySlot).map((entry) => [entry.startsAt, entry.totalPrice]),
  );

  return daySlots.flatMap((slot) => {
    const price = exactSlotPrices.get(slot.startsAt) ?? payload.pricesByHour[String(slot.hour)];
    if (!Number.isFinite(price)) return [];
    return [{
      startsAt: slot.startsAt,
      totalPrice: price,
    }];
  });
};
