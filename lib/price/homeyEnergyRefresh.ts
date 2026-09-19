import { getDateKeyInTimeZone, getDateKeyStartMs, getZonedParts, shiftDateKey } from '../utils/dateUtils';
import { HOMEY_PRICES_TODAY, HOMEY_PRICES_TOMORROW } from '../utils/settingsKeys';
import { formatHomeyEnergyError, type HomeyEnergyApi } from '../utils/homeyEnergy';
import { fetchHomeyEnergyPricesForDate } from './homeyEnergyPriceFetch';
import { getFlowPricePayload, type FlowPricePayload } from '../../packages/shared-domain/src/price/flowPriceUtils';
import { getLogger, type StructuredDebugEmitter } from '../logging/logger';

const priceLogger = getLogger('price');

export type HomeyEnergyFetchResult = Awaited<ReturnType<typeof fetchHomeyEnergyPricesForDate>>;

export type HomeyEnergyResults = {
  todayResult: HomeyEnergyFetchResult;
  tomorrowResult: HomeyEnergyFetchResult;
};

export type HomeyEnergyDateInfo = {
  timeZone: string;
  today: Date;
  tomorrow: Date;
  todayKey: string;
  tomorrowKey: string;
};

export const buildHomeyEnergyDateInfo = (timeZone: string, now = new Date()): HomeyEnergyDateInfo => {
  const today = now;
  // Derive tomorrow from the local date key so 23/25-hour days do not drift.
  const todayKey = getDateKeyInTimeZone(today, timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const tomorrow = new Date(getDateKeyStartMs(tomorrowKey, timeZone));
  return {
    timeZone,
    today,
    tomorrow,
    todayKey,
    tomorrowKey,
  };
};

export const shouldUseHomeyEnergyCache = (params: {
  info: HomeyEnergyDateInfo;
  forceRefresh: boolean;
  getSettingValue: (key: string) => unknown;
  debugStructured: StructuredDebugEmitter;
  updateCombinedPrices: () => void;
}): boolean => {
  const { info, forceRefresh, getSettingValue, debugStructured, updateCombinedPrices } = params;
  if (forceRefresh) return false;
  const cachedToday = getFlowPricePayload(getSettingValue(HOMEY_PRICES_TODAY));
  const cachedTomorrow = getFlowPricePayload(getSettingValue(HOMEY_PRICES_TOMORROW));
  if (cachedToday?.dateKey === info.todayKey && cachedTomorrow?.dateKey === info.tomorrowKey) {
    debugStructured({ event: 'homey_energy_cache_used' });
    updateCombinedPrices();
    return true;
  }
  return false;
};

export const fetchHomeyEnergyResults = async (
  energyApi: HomeyEnergyApi,
  info: HomeyEnergyDateInfo,
  debugStructured: StructuredDebugEmitter,
): Promise<HomeyEnergyResults | null> => {
  const [todayOutcome, tomorrowOutcome] = await Promise.allSettled([
    fetchHomeyEnergyPricesForDate({
      api: energyApi,
      date: info.today,
      timeZone: info.timeZone,
    }),
    fetchHomeyEnergyPricesForDate({
      api: energyApi,
      date: info.tomorrow,
      timeZone: info.timeZone,
    }),
  ]);
  if (todayOutcome.status === 'rejected') {
    priceLogger.error({
      event: 'homey_prices_fetch_failed', date: info.todayKey, ...formatHomeyEnergyError(todayOutcome.reason),
    });
  }
  // Homey answers a day it has no prices for yet with an error (HTTP 500
  // `NotFoundError`), not an empty day, so a rejected tomorrow is the ordinary
  // state until the day-ahead auction is published. It is judged with a missing
  // payload in `logHomeyEnergyPayloadStatus`: pending before 13:00, an error after.
  if (tomorrowOutcome.status === 'rejected') {
    debugStructured({
      event: 'homey_prices_tomorrow_fetch_rejected',
      date: info.tomorrowKey,
      ...formatHomeyEnergyError(tomorrowOutcome.reason),
    });
  }
  if (todayOutcome.status === 'rejected' && tomorrowOutcome.status === 'rejected') return null;

  const emptyResult: HomeyEnergyFetchResult = { payload: null, intervalMinutes: null, priceUnit: null };
  return {
    todayResult: todayOutcome.status === 'fulfilled' ? todayOutcome.value : emptyResult,
    tomorrowResult: tomorrowOutcome.status === 'fulfilled' ? tomorrowOutcome.value : emptyResult,
  };
};

export const logHomeyEnergyPayloadStatus = (
  info: HomeyEnergyDateInfo,
  results: HomeyEnergyResults,
  debugStructured: StructuredDebugEmitter,
): void => {
  if (!results.todayResult.payload) {
    priceLogger.error({
      event: 'homey_prices_missing_today',
      date: info.todayKey,
      intervalMinutes: results.todayResult.intervalMinutes,
      priceUnit: results.todayResult.priceUnit,
    });
  }
  if (!results.tomorrowResult.payload) {
    const details = {
      date: info.tomorrowKey,
      intervalMinutes: results.tomorrowResult.intervalMinutes,
      priceUnit: results.tomorrowResult.priceUnit,
    };
    const localHour = getZonedParts(new Date(), info.timeZone).hour;
    if (localHour < 13) {
      debugStructured({ event: 'homey_energy_tomorrow_pending', ...details });
    } else {
      priceLogger.error({ event: 'homey_prices_missing_tomorrow', ...details });
    }
  }
};

/** The currency is the one the price documents are published in. */
export const updateHomeyEnergyCurrency = (
  results: HomeyEnergyResults,
  writeHomeyPricesCurrency: (unit: string) => void,
): void => {
  const priceUnit = results.todayResult.priceUnit || results.tomorrowResult.priceUnit;
  if (priceUnit) {
    writeHomeyPricesCurrency(priceUnit);
  }
};

export const storeHomeyEnergyPayloads = (params: {
  results: HomeyEnergyResults;
  writeFlowPayload: (key: string, payload: FlowPricePayload | null) => void;
}): number => {
  const { results, writeFlowPayload } = params;
  let stored = 0;
  if (results.todayResult.payload) {
    writeFlowPayload(HOMEY_PRICES_TODAY, results.todayResult.payload);
    stored += 1;
  }
  if (results.tomorrowResult.payload) {
    writeFlowPayload(HOMEY_PRICES_TOMORROW, results.tomorrowResult.payload);
    stored += 1;
  }
  return stored;
};
