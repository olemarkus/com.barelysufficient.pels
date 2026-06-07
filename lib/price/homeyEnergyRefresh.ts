import { getDateKeyInTimeZone, getDateKeyStartMs, getZonedParts, shiftDateKey } from '../utils/dateUtils';
import { HOMEY_PRICES_CURRENCY, HOMEY_PRICES_TODAY, HOMEY_PRICES_TOMORROW } from '../utils/settingsKeys';
import { formatHomeyEnergyError, type HomeyEnergyApi } from '../utils/homeyEnergy';
import { normalizeError } from '../utils/errorUtils';
import { fetchHomeyEnergyCurrency, fetchHomeyEnergyPricesForDate } from './homeyEnergyPriceFetch';
import { getFlowPricePayload } from './flowPriceUtils';
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

export const fetchHomeyEnergyResults = async (params: {
  energyApi: HomeyEnergyApi;
  info: HomeyEnergyDateInfo;
}): Promise<HomeyEnergyResults | null> => {
  const { energyApi, info } = params;
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
  const logFailure = (dateKey: string, error: unknown) => {
    const details = formatHomeyEnergyError(error);
    priceLogger.error({ event: 'homey_prices_fetch_failed', date: dateKey, ...details });
  };
  if (todayOutcome.status === 'rejected') logFailure(info.todayKey, todayOutcome.reason);
  if (tomorrowOutcome.status === 'rejected') logFailure(info.tomorrowKey, tomorrowOutcome.reason);
  if (todayOutcome.status === 'rejected' && tomorrowOutcome.status === 'rejected') return null;

  const emptyResult: HomeyEnergyFetchResult = { payload: null, intervalMinutes: null, priceUnit: null };
  return {
    todayResult: todayOutcome.status === 'fulfilled' ? todayOutcome.value : emptyResult,
    tomorrowResult: tomorrowOutcome.status === 'fulfilled' ? tomorrowOutcome.value : emptyResult,
  };
};

export const logHomeyEnergyPayloadStatus = (params: {
  info: HomeyEnergyDateInfo;
  results: HomeyEnergyResults;
  debugStructured: StructuredDebugEmitter;
}): void => {
  const { info, results, debugStructured } = params;
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

export const updateHomeyEnergyCurrency = async (params: {
  energyApi: HomeyEnergyApi;
  results: HomeyEnergyResults;
  setSetting: (key: string, value: unknown) => void;
}): Promise<void> => {
  const { energyApi, results, setSetting } = params;
  let currency: string | null = null;
  try {
    currency = await fetchHomeyEnergyCurrency(energyApi);
  } catch (error) {
    priceLogger.error({ event: 'homey_energy_currency_fetch_failed', err: normalizeError(error) });
  }
  const priceUnit = currency || results.todayResult.priceUnit || results.tomorrowResult.priceUnit;
  if (priceUnit) {
    setSetting(HOMEY_PRICES_CURRENCY, priceUnit);
  }
};

export const storeHomeyEnergyPayloads = (params: {
  results: HomeyEnergyResults;
  setSetting: (key: string, value: unknown) => void;
}): number => {
  const { results, setSetting } = params;
  let stored = 0;
  if (results.todayResult.payload) {
    setSetting(HOMEY_PRICES_TODAY, results.todayResult.payload);
    stored += 1;
  }
  if (results.tomorrowResult.payload) {
    setSetting(HOMEY_PRICES_TOMORROW, results.tomorrowResult.payload);
    stored += 1;
  }
  return stored;
};
