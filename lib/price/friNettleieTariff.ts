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

// The parser reads a numeric scalar as a number; anything else is not a fee.
const finiteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

// A present field PELS cannot read makes its period malformed: reading past it
// would misprice, e.g. an unknown month name would widen "January" to every
// month. Absent optional fields keep their meaning.
const MALFORMED = Symbol('malformed');
type Read<T> = T | typeof MALFORMED;

// The day tokens tariff.cue allows.
const DAY_TOKENS: ReadonlySet<string> = new Set([
  'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag',
  'ukedag', 'helg', 'helligdager', 'fridag', 'virkedag', 'alle',
]);

const HOUR_TOKEN = /^(\d{1,2})(?:-(\d{1,2}))?$/;

const hourSpan = (from: number, to: number): number[] => (
  Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
);

// "6-21" → [6..21] (inclusive), "5" → [5], and a span past midnight such as
// "22-5" → [22, 23, 0..5]. Range upper bound is inclusive per the fri-nettleie
// spec ("16-21 gjelder fra 16:00 til 21:59:59").
const parseHourToken = (token: unknown): Read<number[]> => {
  const match = HOUR_TOKEN.exec(String(token).trim());
  if (!match) return MALFORMED;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from > 23 || to > 23) return MALFORMED;
  return from <= to ? hourSpan(from, to) : [...hourSpan(from, 23), ...hourSpan(0, to)];
};

// `timer` may be omitted (all hours), a single value, a span string, or a list
// of values/spans.
const parseTimer = (timer: unknown): Read<number[]> => {
  if (timer === undefined || timer === null) return Array.from({ length: 24 }, (_, hour) => hour);
  const tokens = Array.isArray(timer) ? timer : [timer];
  const ranges = tokens.map(parseHourToken);
  if (tokens.length === 0 || ranges.includes(MALFORMED)) return MALFORMED;
  return [...new Set((ranges as number[][]).flat())].sort((a, b) => a - b);
};

const parseMonths = (måneder: unknown): Read<number[] | undefined> => {
  if (måneder === undefined || måneder === null) return undefined;
  if (!Array.isArray(måneder) || måneder.length === 0) return MALFORMED;
  const months = måneder.map((name) => MONTH_NAME_TO_NUMBER[String(name).trim().toLowerCase()]);
  return months.every((month): month is number => month !== undefined) ? months : MALFORMED;
};

const parseDayTypes = (dager: unknown): Read<string[] | undefined> => {
  if (dager === undefined || dager === null) return undefined;
  if (!Array.isArray(dager) || dager.length === 0) return MALFORMED;
  const tokens = dager.map((day) => String(day).trim().toLowerCase());
  return tokens.every((token) => DAY_TOKENS.has(token)) ? tokens : MALFORMED;
};

const parseException = (entry: unknown): Read<FriNettleieException> => {
  if (!isRecord(entry)) return MALFORMED;
  const price = finiteNumber(entry.pris);
  const hours = parseTimer(entry.timer);
  const months = parseMonths(entry.måneder);
  const dayTypes = parseDayTypes(entry.dager);
  if (price === null || hours === MALFORMED || months === MALFORMED || dayTypes === MALFORMED) return MALFORMED;
  return { hours, price, ...(months ? { months } : {}), ...(dayTypes ? { dayTypes } : {}) };
};

const parseExceptions = (unntak: unknown): Read<FriNettleieException[]> => {
  if (unntak === undefined || unntak === null) return [];
  if (!Array.isArray(unntak)) return MALFORMED;
  const exceptions = unntak.map(parseException);
  return exceptions.includes(MALFORMED) ? MALFORMED : exceptions as FriNettleieException[];
};

// Normalise to YYYY-MM-DD so a datetime form (e.g. "2026-01-01T00:00:00") still
// compares correctly against date-only keys.
const dateKeyOf = (value: unknown): string | undefined => {
  const text = typeof value === 'string' ? value.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
};

const parseUntil = (value: unknown): Read<string | undefined> => {
  if (value === undefined || value === null) return undefined;
  return dateKeyOf(value) ?? MALFORMED;
};

const parsePeriod = (tariff: Record<string, unknown>): Read<FriNettleieTariffPeriod> => {
  // A period without a start date cannot be placed in time.
  const from = dateKeyOf(tariff.gyldig_fra);
  const until = parseUntil(tariff.gyldig_til);
  const energiledd = isRecord(tariff.energiledd) ? tariff.energiledd : null;
  const basePrice = finiteNumber(energiledd?.grunnpris);
  const exceptions = parseExceptions(energiledd?.unntak);
  if (from === undefined || until === MALFORMED || basePrice === null || exceptions === MALFORMED) return MALFORMED;
  if (![basePrice, ...exceptions.map((exception) => exception.price)].every(isPlausibleFee)) return MALFORMED;
  return { from, ...(until ? { until } : {}), basePrice, exceptions };
};

// A malformed period that has visibly ended no longer prices anything.
const hasEnded = (tariff: Record<string, unknown>, todayKey: string): boolean => {
  const until = dateKeyOf(tariff.gyldig_til);
  return until !== undefined && until <= todayKey;
};

/**
 * A parsed tariff file read for `todayKey`: its periods still valid that day or
 * starting later, per tariff group and oldest first (`tariffs`); `none` when it
 * holds no such period; `malformed` when it is not a tariff file or holds a
 * period, not visibly ended, that PELS cannot read. A partly read tariff is
 * never returned: it would price the days of the period it could not read on
 * another one.
 */
export type FriNettleieTariffRead =
  | { kind: 'tariffs'; tariffs: FriNettleieTariffs }
  | { kind: 'none' }
  | { kind: 'malformed' };

export const readFriNettleieTariffs = (document: unknown, todayKey: string): FriNettleieTariffRead => {
  if (!isRecord(document) || !Array.isArray(document.tariffer)) return { kind: 'malformed' };
  if (!document.tariffer.every(isRecord)) return { kind: 'malformed' };
  const tariffer = document.tariffer.filter((tariff) => !hasEnded(tariff, todayKey));
  const parsed = tariffer.map((tariff) => ({ tariff, period: parsePeriod(tariff) }));
  if (parsed.some(({ period }) => period === MALFORMED)) return { kind: 'malformed' };
  const groups = KUNDEGRUPPE_TO_TARIFF_GROUP.flatMap(([kundegruppe, group]) => {
    const periods = parsed
      .filter(({ tariff }) => Array.isArray(tariff.kundegrupper) && tariff.kundegrupper.includes(kundegruppe))
      .map(({ period }) => period as FriNettleieTariffPeriod)
      .sort((a, b) => a.from.localeCompare(b.from));
    return periods.length > 0 ? [[group, periods] as const] : [];
  });
  return groups.length > 0 ? { kind: 'tariffs', tariffs: Object.fromEntries(groups) } : { kind: 'none' };
};
