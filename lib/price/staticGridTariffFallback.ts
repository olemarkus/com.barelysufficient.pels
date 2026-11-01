import { getDateKeyInTimeZone, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import { VAT_MULTIPLIER_STANDARD } from './priceComponents';
import {
  GRID_TARIFF_SOURCE_FALLBACK,
  gridTariffDatesOf,
  isGridTariffFallbackData,
  type GridTariffEntryWithSource,
} from './gridTariffUtils';
import type {
  FriNettleieException,
  FriNettleieTariffGroup,
  FriNettleieTariffPeriod,
  FriNettleieTariffs,
} from './friNettleieTariff';
import { NETTLEIE_FALLBACK_BY_ORGNR } from './nettleieFallbackData.generated';

/**
 * When the bundled snapshot was generated, re-exported beside the resolver that
 * serves it: a caller reporting that it fell back to the snapshot needs to say
 * how old the snapshot is, and should not have to know which generated file it
 * came out of.
 */
export { NETTLEIE_FALLBACK_GENERATED_AT } from './nettleieFallbackData.generated';

// Fri Nettleie tariff periods expanded into one grid-tariff row per local hour,
// the shape the price pipeline reads (only the per-day, per-hour
// `energyFeeExVat` is read downstream; see priceServiceNorway.ts). Used for the
// tariff fetched live and for the bundled snapshot when that fetch fails.
//
// Each day is priced on the period valid that day, so an announced tariff
// change applies from its own date. Public holidays are not modelled: they are
// priced as their ordinary weekday.

// Fri Nettleie gives the energy rate without any tax; the grid tariff the price
// pipeline reads carries the Enova fee (øre/kWh, ex VAT).
const ENOVA_FEE_EX_VAT = 1;

// JS getDay()/getUTCDay(): 0 = Sunday … 6 = Saturday.
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const DAY_NAME_TO_WEEKDAY: Readonly<Record<string, number>> = {
  mandag: 1, tirsdag: 2, onsdag: 3, torsdag: 4, fredag: 5, lørdag: 6, søndag: 0,
};

// Resolve a fri-nettleie day token to the weekdays it covers. With holidays out
// of scope, `virkedag` collapses to plain weekdays and `fridag` to the weekend;
// a holiday-only token (`helligdager`) covers nothing and is effectively ignored.
const resolveDayTokenWeekdays = (token: string): readonly number[] => {
  switch (token) {
    case 'ukedag':
    case 'virkedag':
      return WEEKDAYS;
    case 'helg':
    case 'fridag':
      return WEEKEND;
    case 'helligdager':
      return [];
    case 'alle':
      return ALL_DAYS;
    default: {
      const weekday = DAY_NAME_TO_WEEKDAY[token];
      return weekday === undefined ? [] : [weekday];
    }
  }
};

const exceptionAppliesToday = (
  exception: FriNettleieException,
  month: number,
  weekday: number,
): boolean => {
  if (exception.months && !exception.months.includes(month)) return false;
  if (exception.dayTypes) {
    const matchesDay = exception.dayTypes.some((token) => resolveDayTokenWeekdays(token).includes(weekday));
    if (!matchesDay) return false;
  }
  return true;
};

// Resolve the energy fee (øre/kWh, ex VAT) for a single hour: `basePrice` unless
// an exception matches the month + weekday + hour. Later matching exceptions
// override earlier ones (the prices are replacements, not additions).
const resolveHourFeeExVat = (
  period: FriNettleieTariffPeriod,
  month: number,
  weekday: number,
  hour: number,
): number => period.exceptions.reduce(
  (fee, exception) => (
    exceptionAppliesToday(exception, month, weekday) && exception.hours.includes(hour)
      ? exception.price
      : fee
  ),
  period.basePrice,
);

const selectPeriods = (
  tariffs: FriNettleieTariffs,
  tariffGroup: string,
): readonly FriNettleieTariffPeriod[] | undefined => {
  // Prefer the requested group; most operators file an identical tariff for
  // household and holiday-home, so falling back to whichever exists still gives
  // a sensible value rather than nothing.
  const requested = tariffs[tariffGroup as FriNettleieTariffGroup];
  if (requested) return requested;
  return tariffs.Husholdning ?? tariffs['Hytter og fritidshus'];
};

// The latest period started on or before `dateKey` and not yet ended.
const periodFor = (
  periods: readonly FriNettleieTariffPeriod[],
  dateKey: string,
): FriNettleieTariffPeriod | undefined => periods
  .filter((period) => period.from <= dateKey && (period.until === undefined || dateKey < period.until))
  .at(-1);

type GridTariffDayRow = Omit<GridTariffEntryWithSource, 'source'>;

const buildDayRows = (
  tariffs: FriNettleieTariffs,
  tariffGroup: string,
  dateKey: string,
): GridTariffDayRow[] | null => {
  const periods = selectPeriods(tariffs, tariffGroup);
  const period = periods && periodFor(periods, dateKey);
  if (!period) return null;

  const [year, month, day] = dateKey.split('-').map((part) => Number.parseInt(part, 10));
  // A date key that does not split into three parts names no day, so there is no
  // tariff to build for it.
  if (year === undefined || month === undefined || day === undefined) return null;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return Array.from({ length: 24 }, (_, time) => {
    const energyFeeExVat = resolveHourFeeExVat(period, month, weekday, time) + ENOVA_FEE_EX_VAT;
    return {
      time,
      energyFeeExVat,
      // inc-VAT is cosmetic only (downstream reads ex-VAT); mainland VAT is a
      // fair nominal default and the value is unused for VAT-exempt areas.
      energyFeeIncVat: Math.round(energyFeeExVat * VAT_MULTIPLIER_STANDARD * 100) / 100,
      dateKey: `${dateKey}T00:00:00`,
    };
  });
};

/**
 * Grid-tariff rows for the local day of `date` and the day after it, priced on
 * `tariffs`, so tomorrow's spot prices are priced on tomorrow's day type and
 * period; `null` when no period covers today.
 */
export const buildFriNettleieGridTariffDays = (
  tariffs: FriNettleieTariffs,
  tariffGroup: string,
  date: Date,
  timeZone: string,
): GridTariffDayRow[] | null => {
  const today = getDateKeyInTimeZone(date, timeZone);
  const todayRows = buildDayRows(tariffs, tariffGroup, today);
  if (!todayRows) return null;
  const tomorrowRows = buildDayRows(tariffs, tariffGroup, shiftDateKey(today, 1));
  return [...todayRows, ...(tomorrowRows ?? [])];
};

/** The grid company's file in Fri Nettleie; `undefined` when it does not cover it. */
export const friNettleieFileFor = (organizationNumber: string): string | undefined => (
  NETTLEIE_FALLBACK_BY_ORGNR[organizationNumber]?.file
);

/**
 * The bundled snapshot's rows for today and tomorrow, flagged as fallback so
 * they never suppress the next live attempt.
 */
export const buildStaticGridTariffFallback = (params: {
  organizationNumber: string;
  tariffGroup: string;
  date: Date;
  timeZone: string;
}): GridTariffEntryWithSource[] | null => {
  const { organizationNumber, tariffGroup, date, timeZone } = params;
  const operator = NETTLEIE_FALLBACK_BY_ORGNR[organizationNumber];
  if (!operator) return null;
  const rows = buildFriNettleieGridTariffDays(operator.tariffs, tariffGroup, date, timeZone);
  return rows && rows.map((row) => ({ ...row, source: GRID_TARIFF_SOURCE_FALLBACK }));
};

export type GridTariffFallbackOutcome =
  | { kind: 'store'; entries: GridTariffEntryWithSource[] }
  | { kind: 'keepCache' }
  | { kind: 'fallbackCurrent' }
  | { kind: 'clearStaleFallback' }
  | { kind: 'noData' };

// Decides what to do once every live attempt has failed:
//  - real cached data covers today, or the operator has no bundled tariff →
//    keep serving it. A real cache from an earlier day yields to the bundled
//    tariff, which prices each day on its own day type and dated period: the
//    price pipeline would otherwise price every later day on the last cached
//    day while the source stays down;
//  - a static fallback exists and already matches today's values → keep it (no
//    redundant cache write while the sources stay down);
//  - a static fallback exists and differs → seed it;
//  - stale fallback data is cached but the operator no longer has one (e.g. the
//    org number was changed to an untabled operator) → clear it so we never
//    serve another operator's tariff;
//  - nothing cached and no fallback → nothing to serve.
export const resolveGridTariffFallback = (params: {
  existingData: Array<{ dateKey?: string; datoId?: string; source?: unknown }> | null;
  organizationNumber: string;
  tariffGroup: string;
  date: Date;
  timeZone: string;
}): GridTariffFallbackOutcome => {
  const {
    existingData, organizationNumber, tariffGroup, date, timeZone,
  } = params;
  const existingIsFallback = isGridTariffFallbackData(existingData);
  const entries = buildStaticGridTariffFallback({
    organizationNumber, tariffGroup, date, timeZone,
  });
  if (!existingIsFallback && Array.isArray(existingData) && existingData.length > 0) {
    const coversToday = gridTariffDatesOf(existingData).has(getDateKeyInTimeZone(date, timeZone));
    if (coversToday || !entries) return { kind: 'keepCache' };
    return { kind: 'store', entries };
  }
  if (entries) {
    // Compare full content (not just the date) so an org-number change still
    // refreshes, while an unchanged day-over-day fallback skips the flash write.
    if (existingIsFallback && JSON.stringify(existingData) === JSON.stringify(entries)) {
      return { kind: 'fallbackCurrent' };
    }
    return { kind: 'store', entries };
  }
  return existingIsFallback ? { kind: 'clearStaleFallback' } : { kind: 'noData' };
};
