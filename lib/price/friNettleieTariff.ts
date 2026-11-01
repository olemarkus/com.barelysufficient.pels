/**
 * A Fri Nettleie tariff file (https://github.com/kraftsystemet/fri-nettleie,
 * `tariffer/*.yml`, format in its `tariff.cue`) read into the dated energy-fee
 * periods PELS prices on. Shared by the live fetch (`friNettleieFetch.ts`) and
 * the bundled snapshot's generator (`scripts/build-nettleie-fallback.mjs`).
 *
 * Fees are øre/kWh ex VAT and without any other tax, the Enova fee included.
 */

export type FriNettleieException = {
  /** Local hours-of-day (0-23) the exception price applies to. */
  readonly hours: readonly number[];
  /** Months (1-12) the exception applies to; omitted means all months. */
  readonly months?: readonly number[];
  /** fri-nettleie day tokens (e.g. 'virkedag', 'helg'); omitted means all days. */
  readonly dayTypes?: readonly string[];
  /** Replacement energy fee in øre/kWh, ex VAT. */
  readonly price: number;
};

export type FriNettleieTariffPeriod = {
  /** First local day the tariff applies, YYYY-MM-DD. */
  readonly from: string;
  /** First local day it no longer applies, YYYY-MM-DD; omitted while open-ended. */
  readonly until?: string;
  /** Base energy fee in øre/kWh, ex VAT (applies when no exception matches). */
  readonly basePrice: number;
  readonly exceptions: readonly FriNettleieException[];
};

export type FriNettleieTariffGroup = 'Husholdning' | 'Hytter og fritidshus';

/** Each tariff group's periods, oldest first. */
export type FriNettleieTariffs = Partial<Record<FriNettleieTariffGroup, readonly FriNettleieTariffPeriod[]>>;

// fri-nettleie kundegruppe → PELS `nettleie_tariffgruppe` setting value.
const KUNDEGRUPPE_TO_TARIFF_GROUP: ReadonlyArray<readonly [string, FriNettleieTariffGroup]> = [
  ['husholdning', 'Husholdning'],
  ['fritid', 'Hytter og fritidshus'],
];

const MONTH_NAME_TO_NUMBER: Readonly<Record<string, number>> = {
  januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, desember: 12,
};

// An energy fee outside this range (øre/kWh, ex VAT) is not a real tariff: a
// period carrying one is dropped rather than priced on.
const MIN_PLAUSIBLE_FEE = -100;
const MAX_PLAUSIBLE_FEE = 300;

const isPlausibleFee = (fee: number): boolean => fee >= MIN_PLAUSIBLE_FEE && fee <= MAX_PLAUSIBLE_FEE;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const finiteNumber = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number(value);
  return typeof value !== 'boolean' && value !== null && Number.isFinite(number) ? number : null;
};

// "6-21" → [6..21] (inclusive), "5" → [5]. Range upper bound is inclusive per
// the fri-nettleie spec ("16-21 gjelder fra 16:00 til 21:59:59").
const parseHourToken = (token: unknown): number[] => {
  const text = String(token).trim();
  if (text.includes('-')) {
    const [fromRaw, toRaw] = text.split('-');
    const from = Number.parseInt(fromRaw ?? '', 10);
    const to = Number.parseInt(toRaw ?? '', 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return [];
    const first = Math.max(0, from);
    const last = Math.min(23, to);
    return last < first ? [] : Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
  }
  const single = Number.parseInt(text, 10);
  return Number.isInteger(single) && single >= 0 && single <= 23 ? [single] : [];
};

// `timer` may be omitted (all hours), a single value, a span string, or a list
// of values/spans.
const parseTimer = (timer: unknown): number[] => {
  if (timer === undefined || timer === null) return Array.from({ length: 24 }, (_, hour) => hour);
  const hours = new Set<number>();
  for (const token of Array.isArray(timer) ? timer : [timer]) for (const hour of parseHourToken(token)) hours.add(hour);
  return [...hours].sort((a, b) => a - b);
};

const parseMonths = (måneder: unknown): number[] | undefined => {
  if (!Array.isArray(måneder)) return undefined;
  const months = måneder
    .map((name) => MONTH_NAME_TO_NUMBER[String(name).trim().toLowerCase()])
    .filter((month): month is number => month !== undefined);
  return months.length > 0 ? months : undefined;
};

const parseDayTypes = (dager: unknown): string[] | undefined => {
  if (!Array.isArray(dager)) return undefined;
  const tokens = dager.map((day) => String(day).trim().toLowerCase()).filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
};

const parseExceptions = (unntak: unknown): FriNettleieException[] => (Array.isArray(unntak) ? unntak : [])
  .filter(isRecord)
  .flatMap((entry) => {
    const price = finiteNumber(entry.pris);
    const hours = parseTimer(entry.timer);
    if (price === null || hours.length === 0) return [];
    const months = parseMonths(entry.måneder);
    const dayTypes = parseDayTypes(entry.dager);
    return [{ hours, price, ...(months ? { months } : {}), ...(dayTypes ? { dayTypes } : {}) }];
  });

// Normalise to YYYY-MM-DD so a datetime form (e.g. "2026-01-01T00:00:00") still
// compares correctly against date-only keys.
const dateKeyOf = (value: unknown): string | undefined => {
  const text = typeof value === 'string' ? value.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
};

const parsePeriod = (tariff: Record<string, unknown>): FriNettleieTariffPeriod | null => {
  const from = dateKeyOf(tariff.gyldig_fra);
  const energiledd = isRecord(tariff.energiledd) ? tariff.energiledd : null;
  const basePrice = finiteNumber(energiledd?.grunnpris);
  // A period without a start date cannot be placed in time.
  if (from === undefined || basePrice === null) return null;
  const exceptions = parseExceptions(energiledd?.unntak);
  if (![basePrice, ...exceptions.map((exception) => exception.price)].every(isPlausibleFee)) return null;
  const until = dateKeyOf(tariff.gyldig_til);
  return { from, ...(until ? { until } : {}), basePrice, exceptions };
};

/**
 * The periods of a parsed tariff file still valid on `todayKey` (YYYY-MM-DD) or
 * starting later, per tariff group and oldest first; `null` when the document
 * is not a tariff file or holds no such period.
 */
export const readFriNettleieTariffs = (document: unknown, todayKey: string): FriNettleieTariffs | null => {
  if (!isRecord(document) || !Array.isArray(document.tariffer)) return null;
  const tariffer = document.tariffer.filter(isRecord);
  const groups = KUNDEGRUPPE_TO_TARIFF_GROUP.flatMap(([kundegruppe, group]) => {
    const periods = tariffer
      .filter((tariff) => Array.isArray(tariff.kundegrupper) && tariff.kundegrupper.includes(kundegruppe))
      .map(parsePeriod)
      .filter((period): period is FriNettleieTariffPeriod => (
        period !== null && !(period.until !== undefined && period.until <= todayKey)
      ))
      .sort((a, b) => a.from.localeCompare(b.from));
    return periods.length > 0 ? [[group, periods] as const] : [];
  });
  return groups.length > 0 ? Object.fromEntries(groups) : null;
};
