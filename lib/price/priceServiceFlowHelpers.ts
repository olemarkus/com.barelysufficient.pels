import { getDateKeyInTimeZone, shiftDateKey } from '../utils/dateUtils';
import { FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW } from '../utils/settingsKeys';
import {
  buildFlowEntries,
  getExpectedFlowHours,
  getMissingFlowHours,
  parseFlowPricePayloadInput,
  type FlowPricePayload,
} from './flowPriceUtils';

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
  // Compare payloads by local calendar day instead of adding 24h to the current instant.
  const tomorrowKey = shiftDateKey(todayKey, 1);
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
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const dateKey = kind === 'tomorrow' ? shiftDateKey(todayKey, 1) : todayKey;
  const parsed = parseFlowPricePayloadInput(raw, { dateKey, timeZone });
  const pricesByHour = parsed.pricesByHour;

  const payload: FlowPricePayload = {
    dateKey,
    pricesByHour,
    pricesBySlot: parsed.pricesBySlot,
    updatedAt: new Date().toISOString(),
  };

  const settingKey = kind === 'today' ? FLOW_PRICES_TODAY : FLOW_PRICES_TOMORROW;
  setSetting(settingKey, payload);

  const missingHours = getMissingFlowHours(pricesByHour, getExpectedFlowHours(dateKey, timeZone));
  if (missingHours.length > 0) {
    logDebug(`Flow prices: Missing ${missingHours.length} hour(s) for ${dateKey}`, missingHours);
  }

  updateCombinedPrices();

  return {
    dateKey,
    storedCount: parsed.pricesBySlot?.length ?? Object.keys(pricesByHour).length,
    missingHours,
  };
};
