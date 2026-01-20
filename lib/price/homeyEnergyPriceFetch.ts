import { getDateKeyInTimeZone, getZonedParts } from '../utils/dateUtils';
import type { FlowPricePayload } from './flowPriceUtils';
import {
  HomeyEnergyApi,
  HomeyEnergyPriceDocument,
  HomeyEnergyPriceInterval,
  HomeyEnergyPricesResponse,
  resolveCurrencyLabel,
} from '../utils/homeyEnergy';

type HourlyAccumulator = Record<string, { sum: number; count: number }>;

const normalizeNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toHourKey = (date: Date, timeZone: string): string => {
  const { hour } = getZonedParts(date, timeZone);
  return String(hour);
};

const accumulateHourlyValues = (
  intervals: HomeyEnergyPriceInterval[],
  timeZone: string,
  dateKey: string,
): HourlyAccumulator => {
  return intervals.reduce<HourlyAccumulator>((acc, interval) => {
    const startMs = Date.parse(interval.periodStart);
    if (Number.isNaN(startMs)) return acc;
    const value = normalizeNumber(interval.value);
    if (value === null) return acc;
    const startDate = new Date(startMs);
    if (getDateKeyInTimeZone(startDate, timeZone) !== dateKey) return acc;
    const hourKey = toHourKey(startDate, timeZone);
    const current = acc[hourKey] ?? { sum: 0, count: 0 };
    return { ...acc, [hourKey]: { sum: current.sum + value, count: current.count + 1 } };
  }, {});
};

const buildPricesByHour = (
  intervals: HomeyEnergyPriceInterval[],
  timeZone: string,
  dateKey: string,
): Record<string, number> => {
  const buckets = accumulateHourlyValues(intervals, timeZone, dateKey);
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

export const resolveHomeyEnergyDocument = (response: HomeyEnergyPricesResponse | unknown): HomeyEnergyPriceDocument | null => {
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
  const pricesByHour = buildPricesByHour(doc.pricesPerInterval, timeZone, dateKey);
  if (Object.keys(pricesByHour).length === 0) {
    return { payload: null, intervalMinutes: resolveIntervalMinutes(doc), priceUnit: doc.priceUnit ?? null };
  }
  return {
    payload: {
      dateKey,
      pricesByHour,
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
