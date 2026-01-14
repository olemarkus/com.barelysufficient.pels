import {
  buildLocalDayBuckets,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';

export type FlowPricePayload = {
  dateKey: string;
  pricesByHour: Record<string, number>;
  updatedAt: string;
};

type FlowHourlyPrice = {
  startsAt: string;
  totalPrice: number;
};

const isValidHour = (hour: number): boolean => Number.isInteger(hour) && hour >= 0 && hour <= 23;

const normalizeNumeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const addHourPrice = (
  target: Record<string, number>,
  hour: number,
  value: unknown,
): Record<string, number> => {
  if (!isValidHour(hour)) return target;
  const numeric = normalizeNumeric(value);
  if (numeric === null) return target;
  return { ...target, [String(hour)]: numeric };
};

const buildPricesByHour = (input: unknown): Record<string, number> => {
  if (Array.isArray(input)) {
    return input.reduce((acc, value, hour) => addHourPrice(acc, hour, value), {});
  }
  if (input && typeof input === 'object') {
    return Object.entries(input as Record<string, unknown>).reduce(
      (acc, [key, value]) => addHourPrice(acc, Number(key), value),
      {},
    );
  }
  return {};
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

export const parseFlowPriceInput = (raw: unknown): Record<string, number> => {
  const parsed = parseFlowPriceRaw(raw);
  const pricesByHour = buildPricesByHour(parsed);
  if (Object.keys(pricesByHour).length === 0) {
    throw new Error('No valid hourly prices found in price data.');
  }
  return pricesByHour;
};

export const getFlowPricePayload = (raw: unknown): FlowPricePayload | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { dateKey?: unknown; pricesByHour?: unknown; updatedAt?: unknown };
  if (typeof record.dateKey !== 'string' || !record.dateKey) return null;
  const pricesByHour = buildPricesByHour(record.pricesByHour);
  if (Object.keys(pricesByHour).length === 0) return null;
  return {
    dateKey: record.dateKey,
    pricesByHour,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
  };
};

export const getMissingFlowHours = (pricesByHour: Record<string, number>): number[] => (
  Array.from({ length: 24 }, (_, hour) => hour)
    .filter((hour) => !Number.isFinite(pricesByHour[String(hour)]))
);

export const buildFlowEntries = (payload: FlowPricePayload, timeZone: string): FlowHourlyPrice[] => {
  const dayStartUtcMs = getDateKeyStartMs(payload.dateKey, timeZone);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs } = buildLocalDayBuckets({ dayStartUtcMs, nextDayStartUtcMs, timeZone });

  return bucketStartUtcMs.flatMap((bucketStart) => {
    const hour = getZonedParts(new Date(bucketStart), timeZone).hour;
    const price = payload.pricesByHour[String(hour)];
    if (!Number.isFinite(price)) return [];
    return [{
      startsAt: new Date(bucketStart).toISOString(),
      totalPrice: price,
    }];
  });
};
