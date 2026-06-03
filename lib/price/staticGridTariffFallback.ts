import { getDateKeyInTimeZone } from '../utils/dateUtils';
import { VAT_MULTIPLIER_STANDARD } from './priceComponents';
import {
  GRID_TARIFF_SOURCE_FALLBACK,
  isGridTariffFallbackData,
  type GridTariffEntryWithSource,
} from './gridTariffUtils';
import {
  NETTLEIE_FALLBACK_BY_ORGNR,
  type NettleieFallbackException,
  type NettleieFallbackTariff,
  type NettleieFallbackTariffGroup,
} from './nettleieFallbackData.generated';

// Last-resort static grid-tariff fallback. Used only when the NVE API is
// unreachable AND no live tariff has been cached yet (new user). The shape it
// produces matches the normalized `nettleie_data` entries written from NVE, so
// the rest of the price pipeline consumes it unchanged — only the per-hour
// `energyFeeExVat` is actually read downstream (see priceServiceNorway.ts).
//
// Fidelity is intentionally limited (decided with the maintainer): we expand the
// real day-of-week × hour-of-day shape for *today*, but model neither public
// holidays nor future tariff periods. Holidays are treated as their ordinary
// weekday; the snapshot only carries the tariff that was current when generated.

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
    default:
      return token in DAY_NAME_TO_WEEKDAY ? [DAY_NAME_TO_WEEKDAY[token]] : [];
  }
};

const exceptionAppliesToday = (
  exception: NettleieFallbackException,
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
  tariff: NettleieFallbackTariff,
  month: number,
  weekday: number,
  hour: number,
): number => tariff.exceptions.reduce(
  (fee, exception) => (
    exceptionAppliesToday(exception, month, weekday) && exception.hours.includes(hour)
      ? exception.price
      : fee
  ),
  tariff.basePrice,
);

const selectTariff = (
  tariffs: Partial<Record<NettleieFallbackTariffGroup, NettleieFallbackTariff>>,
  tariffGroup: string,
): NettleieFallbackTariff | undefined => {
  // Prefer the requested group; most operators file an identical tariff for
  // household and holiday-home, so falling back to whichever exists still gives
  // a sensible last-resort value rather than nothing.
  const requested = tariffs[tariffGroup as NettleieFallbackTariffGroup];
  if (requested) return requested;
  return tariffs.Husholdning ?? tariffs['Hytter og fritidshus'];
};

export const buildStaticGridTariffFallback = (params: {
  organizationNumber: string;
  tariffGroup: string;
  date: Date;
  timeZone: string;
}): GridTariffEntryWithSource[] | null => {
  const { organizationNumber, tariffGroup, date, timeZone } = params;
  const operator = NETTLEIE_FALLBACK_BY_ORGNR[organizationNumber];
  if (!operator) return null;
  const tariff = selectTariff(operator.tariffs, tariffGroup);
  if (!tariff) return null;

  const dateKey = getDateKeyInTimeZone(date, timeZone);
  const [year, month, day] = dateKey.split('-').map((part) => Number.parseInt(part, 10));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return Array.from({ length: 24 }, (_, time) => {
    const energyFeeExVat = resolveHourFeeExVat(tariff, month, weekday, time);
    return {
      time,
      energyFeeExVat,
      // inc-VAT is cosmetic only (downstream reads ex-VAT); mainland VAT is a
      // fair nominal default and the value is unused for VAT-exempt areas.
      energyFeeIncVat: Math.round(energyFeeExVat * VAT_MULTIPLIER_STANDARD * 100) / 100,
      // fri-nettleie fixed charges use a different unit (NOK/year per capacity
      // step) and PELS does not consume fixed fees in price combining, so 0.
      fixedFeeExVat: 0,
      fixedFeeIncVat: 0,
      dateKey: `${dateKey}T00:00:00`,
      source: GRID_TARIFF_SOURCE_FALLBACK,
    };
  });
};

export type GridTariffFallbackOutcome =
  | { kind: 'store'; entries: GridTariffEntryWithSource[] }
  | { kind: 'keepCache' }
  | { kind: 'fallbackCurrent' }
  | { kind: 'clearStaleFallback' }
  | { kind: 'noData' };

// Decides what to do once every NVE attempt has failed:
//  - real cached data exists → keep serving it;
//  - a static fallback exists and already matches today's values → keep it (no
//    redundant settings write while NVE stays down);
//  - a static fallback exists and differs → seed it;
//  - stale fallback data is cached but the operator no longer has one (e.g. the
//    org number was changed to an untabled operator) → clear it so we never
//    serve another operator's tariff;
//  - nothing cached and no fallback → nothing to serve.
export const resolveGridTariffFallback = (params: {
  existingData: Array<{ source?: unknown }> | null;
  organizationNumber: string;
  tariffGroup: string;
  date: Date;
  timeZone: string;
}): GridTariffFallbackOutcome => {
  const {
    existingData, organizationNumber, tariffGroup, date, timeZone,
  } = params;
  const existingIsFallback = isGridTariffFallbackData(existingData);
  if (!existingIsFallback && Array.isArray(existingData) && existingData.length > 0) {
    return { kind: 'keepCache' };
  }
  const entries = buildStaticGridTariffFallback({
    organizationNumber, tariffGroup, date, timeZone,
  });
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
