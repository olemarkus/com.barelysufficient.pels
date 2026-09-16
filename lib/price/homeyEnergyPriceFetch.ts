import { getDateKeyInTimeZone } from '../utils/dateUtils';
import {
  buildPricesByHourFromPeriods,
  DEFAULT_PERIOD_MINUTES,
  type FlowPricePeriod,
  type FlowPricePayload,
} from '../../packages/shared-domain/src/price/flowPriceUtils';
import { toHourlyPeriods } from './hourlyPriceProjection';
import {
  HomeyEnergyApi,
  HomeyEnergyPriceDocument,
  HomeyEnergyPriceInterval,
  HomeyEnergyPricesResponse,
  resolveCurrencyLabel,
} from '../utils/homeyEnergy';

const normalizeNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

/**
 * How long one published interval covers. `periodEnd` is the source's own
 * answer and is what a zone on a mixed grid would differ on; the document-level
 * interval length is the fallback, and an hour the last resort.
 */
const resolvePeriodMinutes = (
  interval: HomeyEnergyPriceInterval,
  startMs: number,
  documentIntervalMinutes: number | null,
): number => {
  const endMs = typeof interval.periodEnd === 'string' ? Date.parse(interval.periodEnd) : NaN;
  const spanMinutes = Number.isFinite(endMs) ? (endMs - startMs) / 60_000 : NaN;
  if (Number.isFinite(spanMinutes) && spanMinutes > 0 && spanMinutes <= 24 * 60) return spanMinutes;
  if (documentIntervalMinutes !== null && documentIntervalMinutes > 0) return documentIntervalMinutes;
  return DEFAULT_PERIOD_MINUTES;
};

/**
 * The day's priced periods, at the length Homey Energy published them — 24
 * hours on an hourly zone, 96 quarters on a 15-minute one.
 *
 * At the 15-minute interval the API lists every quarter TWICE with an identical
 * payload (192 entries for one day, 96 distinct starts, verified against a live
 * zone 2026-09-15), so a repeated start is dropped rather than counted as a
 * second period.
 */
const buildPricePeriods = (
  intervals: HomeyEnergyPriceInterval[],
  timeZone: string,
  dateKey: string,
  documentIntervalMinutes: number | null,
): FlowPricePeriod[] => {
  const byStart = intervals.reduce<Map<string, FlowPricePeriod>>((acc, interval) => {
    const startMs = Date.parse(interval.periodStart);
    if (Number.isNaN(startMs)) return acc;
    const value = normalizeNumber(interval.value);
    if (value === null) return acc;
    const startDate = new Date(startMs);
    if (getDateKeyInTimeZone(startDate, timeZone) !== dateKey) return acc;
    const startsAt = startDate.toISOString();
    if (acc.has(startsAt)) return acc;
    acc.set(startsAt, {
      startsAt,
      totalPrice: value,
      durationMinutes: resolvePeriodMinutes(interval, startMs, documentIntervalMinutes),
    });
    return acc;
  }, new Map<string, FlowPricePeriod>());

  return Array.from(byStart.values())
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
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
  return response;
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
  const intervalMinutes = resolveIntervalMinutes(doc);
  const periods = buildPricePeriods(doc.pricesPerInterval, timeZone, dateKey, intervalMinutes);
  // Three views of one day, because they answer to different readers:
  // `pricesByHour` is the clock-hour map the owner's missing-hour diagnostics
  // use, `pricesBySlot` is the hourly series this key has always held (an older
  // app build reinstalled over this payload reads it and is right), and
  // `pricesByPeriod` carries the source's own periods when they are finer.
  const pricesByHour = buildPricesByHourFromPeriods(periods, timeZone);
  const pricesBySlot = toHourlyPeriods(periods, timeZone);
  const isSubHourly = periods.some((period) => period.durationMinutes < DEFAULT_PERIOD_MINUTES);
  if (pricesBySlot.length === 0 && Object.keys(pricesByHour).length === 0) {
    return { payload: null, intervalMinutes, priceUnit: doc.priceUnit ?? null };
  }
  return {
    payload: {
      dateKey,
      pricesByHour,
      pricesBySlot: pricesBySlot.length > 0 ? pricesBySlot : undefined,
      pricesByPeriod: isSubHourly ? periods : undefined,
      updatedAt: new Date().toISOString(),
    },
    intervalMinutes,
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
