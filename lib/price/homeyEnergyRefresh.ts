import { getDateKeyInTimeZone, getZonedParts } from '../utils/dateUtils';
import { HOMEY_PRICES_CURRENCY, HOMEY_PRICES_TODAY, HOMEY_PRICES_TOMORROW } from '../utils/settingsKeys';
import { formatHomeyEnergyError, type HomeyEnergyApi } from '../utils/homeyEnergy';
import { fetchHomeyEnergyCurrency, fetchHomeyEnergyPricesForDate } from './homeyEnergyPriceFetch';
import { getFlowPricePayload } from './flowPriceUtils';

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
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  return {
    timeZone,
    today,
    tomorrow,
    todayKey: getDateKeyInTimeZone(today, timeZone),
    tomorrowKey: getDateKeyInTimeZone(tomorrow, timeZone),
  };
};

export const shouldUseHomeyEnergyCache = (params: {
  info: HomeyEnergyDateInfo;
  forceRefresh: boolean;
  getSettingValue: (key: string) => unknown;
  logDebug: (...args: unknown[]) => void;
  updateCombinedPrices: () => void;
}): boolean => {
  const { info, forceRefresh, getSettingValue, logDebug, updateCombinedPrices } = params;
  if (forceRefresh) return false;
  const cachedToday = getFlowPricePayload(getSettingValue(HOMEY_PRICES_TODAY));
  const cachedTomorrow = getFlowPricePayload(getSettingValue(HOMEY_PRICES_TOMORROW));
  if (cachedToday?.dateKey === info.todayKey && cachedTomorrow?.dateKey === info.tomorrowKey) {
    logDebug('Homey prices: Using cached data');
    updateCombinedPrices();
    return true;
  }
  return false;
};

export const fetchHomeyEnergyResults = async (params: {
  energyApi: HomeyEnergyApi;
  info: HomeyEnergyDateInfo;
  log: (...args: unknown[]) => void;
  errorLog?: (...args: unknown[]) => void;
}): Promise<HomeyEnergyResults | null> => {
  const { energyApi, info, log, errorLog } = params;
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
    if (errorLog) {
      errorLog(`Homey prices: Failed to fetch price data for ${dateKey}`, details);
    } else {
      log(`Homey prices: Failed to fetch price data for ${dateKey}`, details);
    }
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
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  errorLog?: (...args: unknown[]) => void;
}): void => {
  const { info, results, log, logDebug, errorLog } = params;
  if (!results.todayResult.payload) {
    const details = {
      date: info.todayKey,
      intervalMinutes: results.todayResult.intervalMinutes,
      priceUnit: results.todayResult.priceUnit,
    };
    if (errorLog) {
      errorLog('Homey prices: Missing today price data', details);
    } else {
      log('Homey prices: Missing today price data', details);
    }
  }
  if (!results.tomorrowResult.payload) {
    const details = {
      date: info.tomorrowKey,
      intervalMinutes: results.tomorrowResult.intervalMinutes,
      priceUnit: results.tomorrowResult.priceUnit,
    };
    const localHour = getZonedParts(new Date(), info.timeZone).hour;
    if (localHour < 13) {
      logDebug('Homey prices: Tomorrow data not available yet (before 13:00)', details);
    } else if (errorLog) {
      errorLog('Homey prices: Missing tomorrow price data after 13:00', details);
    } else {
      log('Homey prices: Missing tomorrow price data after 13:00', details);
    }
  }
};

export const updateHomeyEnergyCurrency = async (params: {
  energyApi: HomeyEnergyApi;
  results: HomeyEnergyResults;
  setSetting: (key: string, value: unknown) => void;
  logDebug: (...args: unknown[]) => void;
}): Promise<void> => {
  const { energyApi, results, setSetting, logDebug } = params;
  let currency: string | null = null;
  try {
    currency = await fetchHomeyEnergyCurrency(energyApi);
  } catch (error) {
    logDebug('Homey prices: Failed to fetch currency', error);
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
