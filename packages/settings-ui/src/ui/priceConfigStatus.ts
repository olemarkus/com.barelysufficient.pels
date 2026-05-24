import { getHomeyTimezone } from './homey.ts';
import { getDateKeyInTimeZone, shiftDateKey } from './timezone.ts';
import { getTimeAgo } from './utils.ts';
import {
  getFlowPricePayload,
  getExpectedFlowHours,
  buildFlowDaySlots,
  getMissingFlowHours,
} from '../../../shared-domain/src/price/flowPriceUtils.ts';
import type { SettingsUiPricesPayload } from '../../../contracts/src/settingsUiApi.ts';
import type { FlowStatus, HomeyStatus } from './priceConfigTypes.ts';

type FlowStatusTone = 'ok' | 'warn';

const getFlowPayloadStatus = (
  payload: ReturnType<typeof getFlowPricePayload> | null,
  expectedDateKey: string,
  timeZone: string,
): { text: string; tone: FlowStatusTone } => {
  if (!payload) return { text: 'No data received', tone: 'warn' };

  const expectedHours = getExpectedFlowHours(payload.dateKey, timeZone);
  const expectedSlots = buildFlowDaySlots(payload.dateKey, timeZone);
  const hasExactSlots = Array.isArray(payload.pricesBySlot) && payload.pricesBySlot.length > 0;

  const storedCount = hasExactSlots
    ? (payload.pricesBySlot?.length ?? 0)
    : Object.keys(payload.pricesByHour).length;
  const expectedCount = hasExactSlots ? expectedSlots.length : expectedHours.length;
  const missingCount = hasExactSlots
    ? Math.max(0, expectedSlots.length - storedCount)
    : getMissingFlowHours(payload.pricesByHour, expectedHours).length;
  const unitLabel = hasExactSlots ? 'slots' : 'hours';

  const updatedAt = new Date(payload.updatedAt);
  const updatedText = Number.isNaN(updatedAt.getTime())
    ? 'updated time unknown'
    : `updated ${getTimeAgo(updatedAt, new Date(), timeZone)}`;
  const dateMismatch = payload.dateKey !== expectedDateKey;
  const missingSuffix = missingCount > 0 ? ` (${missingCount} missing)` : '';
  const dateSuffix = dateMismatch ? ` (payload ${payload.dateKey})` : '';

  return {
    text: `${storedCount}/${expectedCount} ${unitLabel}${missingSuffix}, ${updatedText}${dateSuffix}`,
    tone: dateMismatch || missingCount > 0 ? 'warn' : 'ok',
  };
};

export const buildFlowStatus = (pricesPayload: SettingsUiPricesPayload): FlowStatus => {
  const timeZone = getHomeyTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const todayStatus = getFlowPayloadStatus(getFlowPricePayload(pricesPayload.flowToday), todayKey, timeZone);
  const tomorrowStatus = getFlowPayloadStatus(getFlowPricePayload(pricesPayload.flowTomorrow), tomorrowKey, timeZone);
  return { today: todayStatus, tomorrow: tomorrowStatus };
};

export const buildHomeyStatus = (pricesPayload: SettingsUiPricesPayload): HomeyStatus => {
  const timeZone = getHomeyTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const currency = pricesPayload.homeyCurrency || 'Unknown';
  const todayStatus = getFlowPayloadStatus(getFlowPricePayload(pricesPayload.homeyToday), todayKey, timeZone);
  const tomorrowStatus = getFlowPayloadStatus(getFlowPricePayload(pricesPayload.homeyTomorrow), tomorrowKey, timeZone);
  return {
    currency,
    currencyTone: currency === 'Unknown' ? 'warn' : 'ok',
    today: todayStatus,
    tomorrow: tomorrowStatus,
  };
};
