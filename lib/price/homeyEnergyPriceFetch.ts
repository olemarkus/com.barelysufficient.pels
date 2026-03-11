import { getDateKeyInTimeZone, getHourStartInTimeZone, getZonedParts } from '../utils/dateUtils';
import { buildFlowDaySlots, type FlowHourlyPrice, type FlowPricePayload } from './flowPriceUtils';
import {
  HomeyEnergyApi,
  HomeyEnergyPriceDocument,
  HomeyEnergyPriceInterval,
  HomeyEnergyPricesResponse,
  resolveCurrencyLabel,
} from '../utils/homeyEnergy';

type SlotAccumulator = Record<string, { sum: number; count: number }>;

const normalizeNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const accumulateSlotValues = (
  intervals: HomeyEnergyPriceInterval[],
  timeZone: string,
  dateKey: string,
): SlotAccumulator => {
  const daySlots = buildFlowDaySlots(dateKey, timeZone);
  const validSlotKeys = new Set(daySlots.map((slot) => slot.startsAt));
  return intervals.reduce<SlotAccumulator>((acc, interval) => {
    const startMs = Date.parse(interval.periodStart);
    if (Number.isNaN(startMs)) return acc;
    const value = normalizeNumber(interval.value);
    if (value === null) return acc;
    const startDate = new Date(startMs);
    if (getDateKeyInTimeZone(startDate, timeZone) !== dateKey) return acc;
    const slotKey = new Date(getHourStartInTimeZone(startDate, timeZone)).toISOString();
    if (!validSlotKeys.has(slotKey)) return acc;
    const current = acc[slotKey] ?? { sum: 0, count: 0 };
    return { ...acc, [slotKey]: { sum: current.sum + value, count: current.count + 1 } };
  }, {});
};

const buildPricesBySlot = (
  intervals: HomeyEnergyPriceInterval[],
  timeZone: string,
  dateKey: string,
): FlowHourlyPrice[] => {
  const slotBuckets = accumulateSlotValues(intervals, timeZone, dateKey);
  return buildFlowDaySlots(dateKey, timeZone).flatMap((slot) => {
    const bucket = slotBuckets[slot.startsAt];
    if (!bucket || bucket.count === 0) return [];
    return [{
      startsAt: slot.startsAt,
      totalPrice: bucket.sum / bucket.count,
    }];
  });
};

const buildPricesByHour = (
  slotPrices: FlowHourlyPrice[],
  timeZone: string,
): Record<string, number> => {
  const buckets = slotPrices.reduce<Record<string, { sum: number; count: number }>>((acc, entry) => {
    const startsAtMs = Date.parse(entry.startsAt);
    if (!Number.isFinite(startsAtMs)) return acc;
    const hourKey = String(getZonedParts(new Date(startsAtMs), timeZone).hour);
    const current = acc[hourKey] ?? { sum: 0, count: 0 };
    return {
      ...acc,
      [hourKey]: { sum: current.sum + entry.totalPrice, count: current.count + 1 },
    };
  }, {});

  return Object.entries(buckets).reduce<Record<string, number>>((acc, [hourKey, bucket]) => {
    if (bucket.count === 0) return acc;
    return { ...acc, [hourKey]: bucket.sum / bucket.count };
  }, {});
};

const resolveIntervalMinutes = (doc: HomeyEnergyPriceDocument): number | null => {
  const fromInterval = normalizeNumber(doc.interval);
  if (fromInterval !== null) return fromInterval;
  const fromPriceInterval = normalizeNumber(doc.priceInterval);
  return fromPriceInterval !== null ? fromPriceInterval : null;
};

export const resolveHomeyEnergyDocument = (
  response: HomeyEnergyPricesResponse | unknown,
): HomeyEnergyPriceDocument | null => {
  if (!response || typeof response !== 'object') return null;
  if (Array.isArray(response)) {
    return response.length > 0 && response[0] && typeof response[0] === 'object'
      ? response[0] as HomeyEnergyPriceDocument
      : null;
  }
  return response as HomeyEnergyPriceDocument;
};

export const normalizeHomeyEnergyPrices = (params: {
  response: HomeyEnergyPricesResponse | unknown;
  date: Date;
  timeZone: string;
}): { payload: FlowPricePayload | null; intervalMinutes: number | null; priceUnit: string | null } => {
  const { response, date, timeZone } = params;
  const doc = resolveHomeyEnergyDocument(response);
  if (!doc || !Array.isArray(doc.pricesPerInterval)) {
    return { payload: null, intervalMinutes: null, priceUnit: null };
  }
  const dateKey = getDateKeyInTimeZone(date, timeZone);
  const pricesBySlot = buildPricesBySlot(doc.pricesPerInterval, timeZone, dateKey);
  const pricesByHour = buildPricesByHour(pricesBySlot, timeZone);
  if (pricesBySlot.length === 0 && Object.keys(pricesByHour).length === 0) {
    return { payload: null, intervalMinutes: resolveIntervalMinutes(doc), priceUnit: doc.priceUnit ?? null };
  }
  return {
    payload: {
      dateKey,
      pricesByHour,
      pricesBySlot: pricesBySlot.length > 0 ? pricesBySlot : undefined,
      updatedAt: new Date().toISOString(),
    },
    intervalMinutes: resolveIntervalMinutes(doc),
    priceUnit: doc.priceUnit ?? null,
  };
};

export const fetchHomeyEnergyPricesForDate = async (params: {
  api: HomeyEnergyApi;
  date: Date;
  timeZone: string;
}): Promise<{ payload: FlowPricePayload | null; intervalMinutes: number | null; priceUnit: string | null }> => {
  const { api, date, timeZone } = params;
  const dateKey = getDateKeyInTimeZone(date, timeZone);
  const response = await api.fetchDynamicElectricityPrices({ date: dateKey });
  return normalizeHomeyEnergyPrices({ response, date, timeZone });
};

export const fetchHomeyEnergyCurrency = async (api: HomeyEnergyApi): Promise<string | null> => {
  if (typeof api.getCurrency !== 'function') return null;
  const raw = await api.getCurrency();
  return resolveCurrencyLabel(raw);
};
