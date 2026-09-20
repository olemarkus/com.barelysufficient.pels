import { getHomeyTimezone } from './homey.ts';
import { getDateKeyInTimeZone, getZonedParts, shiftDateKey } from './timezone.ts';
import { getTimeAgo } from './utils.ts';
import {
  getFlowPricePayload,
  getExpectedFlowHours,
  getMissingFlowHours,
} from '../../../shared-domain/src/price/flowPriceUtils.ts';
import type { SettingsUiPricesPayload } from '../../../contracts/src/settingsUiApi.ts';
import type { FlowStatus, HomeyStatus, PowerhourStatus } from './priceConfigTypes.ts';

type FlowStatusTone = 'ok' | 'warn';

const getFlowPayloadStatus = (
  payload: ReturnType<typeof getFlowPricePayload> | null,
  expectedDateKey: string,
  timeZone: string,
  /**
   * Which of the day's hours the source could have supplied. Defaults to all of
   * them; Power by the Hour publishes only from the current period onwards, so
   * on the day PELS starts reading it the earlier hours were never on offer and
   * counting them as missing would report a fault that is not one.
   */
  countableHours?: (dateKey: string) => number[],
): { text: string; tone: FlowStatusTone } => {
  if (!payload) return { text: 'No data received', tone: 'warn' };

  const dayHours = getExpectedFlowHours(payload.dateKey, timeZone);
  // Counted in hours whatever the source's period length: a zone on the
  // 15-minute market sends four prices per hour, and "96/24" would read as a
  // fault rather than as a full day. `pricesByHour` is the producer's own hour
  // view of the same day, so the count needs no second derivation here.
  const storedCount = Object.keys(payload.pricesByHour).length;
  // The RATIO is always against the whole day, because that is the population
  // `storedCount` counts — a merged day holds hours the source has stopped
  // offering, and "18/9 hours" is what a narrower denominator produces.
  // `countableHours` narrows only the MISSING count, which is a different
  // question: of the hours this source could still have supplied, how many did
  // it not?
  const expectedCount = dayHours.length;
  const missingCount = getMissingFlowHours(
    payload.pricesByHour,
    countableHours ? countableHours(payload.dateKey) : dayHours,
  ).length;
  const unitLabel = 'hours';

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

/**
 * What to tell the owner about Homey's price setup.
 *
 * Only the two states that leave the home with NO prices say anything — the
 * rest is working, and a status row for "everything is fine" is noise. The
 * copy names what the owner can actually do about it, in Homey's own words
 * ("Energy > Electricity"), because the fix is there and not in PELS.
 */
const buildPriceSetupIssue = (
  status: SettingsUiPricesPayload['homeyPriceFormula'] | undefined,
): HomeyStatus['priceSetupIssue'] => {
  if (status?.kind === 'unsupported') {
    return {
      value: { text: 'Not usable', tone: 'warn' },
      detail: 'Your price setup in Homey uses something PELS can’t work out '
        + `(${status.expression}). Prices are paused until it’s simplified `
        + 'under Energy > Electricity in Homey.',
    };
  }
  if (status?.kind === 'prices_nothing') {
    return {
      value: { text: 'No usable prices', tone: 'warn' },
      detail: `Your price setup in Homey (${status.expression}) doesn’t produce a `
        + 'usable price for any hour right now, so prices are paused. Check it '
        + 'under Energy > Electricity in Homey.',
    };
  }
  if (status?.kind === 'unknown') {
    return {
      value: { text: 'Not read yet', tone: 'warn' },
      detail: 'PELS hasn’t managed to read your price setup from Homey yet, '
        + 'so prices are paused. It tries again every few hours — or press '
        + 'Refresh prices.',
    };
  }
  return null;
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
    priceSetupIssue: buildPriceSetupIssue(pricesPayload.homeyPriceFormula),
  };
};

/**
 * The hours of `dateKey` a source that only publishes forward could still have
 * supplied: every hour of tomorrow, and the current hour onwards for today.
 *
 * A day that is not today or tomorrow counts as a whole day. It is not a state
 * this reaches in practice (the rotation clears a payload dated outside its
 * slot), and a day already flagged as misdated should not ALSO be reported as
 * `0/0 hours`, which reads as a fault of its own.
 */
const hoursStillOnOffer = (
  dateKey: string,
  todayKey: string,
  timeZone: string,
  now: Date,
): number[] => {
  const dayHours = getExpectedFlowHours(dateKey, timeZone);
  if (dateKey !== todayKey) return dayHours;
  const { hour } = getZonedParts(now, timeZone);
  return dayHours.filter((dayHour) => dayHour >= hour);
};

export const buildPowerhourStatus = (pricesPayload: SettingsUiPricesPayload): PowerhourStatus => {
  const timeZone = getHomeyTimezone();
  const now = new Date();
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const countable = (dateKey: string) => hoursStillOnOffer(dateKey, todayKey, timeZone, now);
  const currency = pricesPayload.powerhourCurrency || 'Unknown';
  const today = getFlowPricePayload(pricesPayload.powerhourToday);
  const tomorrow = getFlowPricePayload(pricesPayload.powerhourTomorrow);
  return {
    source: pricesPayload.powerhourSource,
    currency,
    currencyTone: currency === 'Unknown' ? 'warn' : 'ok',
    today: getFlowPayloadStatus(today, todayKey, timeZone, countable),
    tomorrow: getFlowPayloadStatus(tomorrow, tomorrowKey, timeZone, countable),
    hasStoredDays: today !== null || tomorrow !== null,
  };
};
