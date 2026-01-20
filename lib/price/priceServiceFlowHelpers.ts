import { getDateKeyInTimeZone } from '../utils/dateUtils';
import { FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW } from '../utils/settingsKeys';
import {
  buildFlowEntries,
  getMissingFlowHours,
  parseFlowPriceInput,
  type FlowPricePayload,
} from './flowPriceUtils';
import { addDays } from './priceServiceUtils';

type BaseHourlyPrice = {
  startsAt: string;
  totalPrice: number;
};

type CombinedPayloadParams = {
  now: Date;
  timeZone: string;
  todayPayload: FlowPricePayload | null;
  tomorrowPayload: FlowPricePayload | null;
  logDebug: (...args: unknown[]) => void;
  label: 'Flow prices' | 'Homey prices';
  allowTomorrowAsToday: boolean;
};

export const buildCombinedHourlyPricesFromPayloads = (params: CombinedPayloadParams): BaseHourlyPrice[] => {
  const {
    now,
    timeZone,
    todayPayload,
    tomorrowPayload,
    logDebug,
    label,
    allowTomorrowAsToday,
  } = params;
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  const tomorrowKey = getDateKeyInTimeZone(addDays(now, 1), timeZone);
  const resolvePayload = (
    payload: FlowPricePayload | null,
    key: string,
    slot: 'today' | 'tomorrow',
  ): { entries: BaseHourlyPrice[]; used: boolean } => {
    if (payload?.dateKey !== key) {
      if (payload) {
        logDebug(`${label}: Ignoring stored ${slot} data for ${payload.dateKey} (expected ${key})`);
      }
      return { entries: [], used: false };
    }
    return { entries: buildFlowEntries(payload, timeZone), used: true };
  };

  const todayResult = resolvePayload(todayPayload, todayKey, 'today');
  const useTomorrowAsToday = allowTomorrowAsToday && !todayResult.used && tomorrowPayload?.dateKey === todayKey;
  const todayEntries = useTomorrowAsToday && tomorrowPayload
    ? buildFlowEntries(tomorrowPayload, timeZone)
    : todayResult.entries;
  if (useTomorrowAsToday && tomorrowPayload) {
    logDebug(`${label}: Using stored tomorrow data for ${todayKey} as today`);
  }

  const tomorrowEntries = useTomorrowAsToday
    ? []
    : resolvePayload(tomorrowPayload, tomorrowKey, 'tomorrow').entries;

  return [...todayEntries, ...tomorrowEntries]
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
};

type StoreFlowPriceParams = {
  kind: 'today' | 'tomorrow';
  raw: unknown;
  timeZone: string;
  logDebug: (...args: unknown[]) => void;
  setSetting: (key: string, value: unknown) => void;
  updateCombinedPrices: () => void;
};

export const storeFlowPriceData = (params: StoreFlowPriceParams): {
  dateKey: string;
  storedCount: number;
  missingHours: number[];
} => {
  const { kind, raw, timeZone, logDebug, setSetting, updateCombinedPrices } = params;
  const pricesByHour = parseFlowPriceInput(raw);
  const baseDate = kind === 'tomorrow' ? addDays(new Date(), 1) : new Date();
  const dateKey = getDateKeyInTimeZone(baseDate, timeZone);

  const payload: FlowPricePayload = {
    dateKey,
    pricesByHour,
    updatedAt: new Date().toISOString(),
  };

  const settingKey = kind === 'today' ? FLOW_PRICES_TODAY : FLOW_PRICES_TOMORROW;
  setSetting(settingKey, payload);

  const missingHours = getMissingFlowHours(pricesByHour);
  if (missingHours.length > 0) {
    logDebug(`Flow prices: Missing ${missingHours.length} hour(s) for ${dateKey}`, missingHours);
  }

  updateCombinedPrices();

  return {
    dateKey,
    storedCount: Object.keys(pricesByHour).length,
    missingHours,
  };
};
