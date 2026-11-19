import type { NorwayCapacityTariffRead } from '../../packages/contracts/src/norwayCapacityTariff';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { parseFriNettleieYaml } from './friNettleieYaml';
import { readSavedFriNettleieFile } from './friNettleieFetch';
import { friNettleieFileFor } from './gridTariffFallback';

const GROUPS: Readonly<Record<string, string>> = {
  Husholdning: 'husholdning',
  'Hytter og fritidshus': 'fritid',
};

// Capacity is read independently: malformed fastledd must never erase usable energy rates.
export function readNorwayCapacityTariff(
  document: unknown,
  organizationNumber: string,
  tariffGroup: string,
  monthKey: string,
): NorwayCapacityTariffRead {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    return { state: 'unavailable', reason: 'invalid_month' };
  }
  if (!isUnknownRecord(document) || !Array.isArray(document.tariffer)) {
    return { state: 'unavailable', reason: 'invalid_tariff_file' };
  }
  const group = GROUPS[tariffGroup];
  if (!group) return { state: 'unsupported', reason: 'unsupported_customer_group' };
  const start = `${monthKey}-01`;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5));
  const next = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
  const rawPeriods: unknown[] = document.tariffer;
  const periods = rawPeriods.filter(isUnknownRecord).filter((entry) => (
    Array.isArray(entry.kundegrupper) && entry.kundegrupper.includes(group)
  )).map(normalizePeriodDates).filter((entry) => !visiblyOutsideMonth(entry, start, next));
  // A malformed date cannot safely be treated as a period outside this month.
  if (periods.some((entry) => !isDate(entry.gyldig_fra)
    || (entry.gyldig_til != null && !isDate(entry.gyldig_til)))) {
    return { state: 'unavailable', reason: 'invalid_tariff_dates' };
  }
  const period = selectMonthPeriod(periods, start, next);
  if (!period) return { state: 'unsupported', reason: 'no_single_month_tariff' };
  const fixed = period.fastledd;
  if (!isUnknownRecord(fixed) || fixed.metode !== 'TRE_DØGNMAX_MND') {
    return { state: 'unsupported', reason: 'unsupported_capacity_method' };
  }
  if (typeof fixed.terskel_inkludert !== 'boolean') {
    return { state: 'unsupported', reason: 'unknown_boundary_rule' };
  }
  const boundariesKw = readBoundaries(fixed.terskler);
  if (!boundariesKw) return { state: 'unavailable', reason: 'invalid_capacity_boundaries' };
  return {
    state: 'supported',
    tariff: {
      // No validity dates: an operator publishing next period's start date leaves this month's tiers unchanged.
      identity: JSON.stringify([organizationNumber, tariffGroup, boundariesKw, fixed.terskel_inkludert]),
      boundariesKw,
      thresholdIncluded: fixed.terskel_inkludert,
    },
  };
}

const isDate = (value: unknown): value is string => (
  typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
);

/** Only the selected operator's saved source can establish its capacity tariff. */
export function readSavedNorwayCapacityTariff(
  raw: unknown,
  organizationNumber: string,
  tariffGroup: string,
  monthKey: string,
): NorwayCapacityTariffRead {
  const saved = readSavedFriNettleieFile(raw);
  if (!saved || saved.organizationNumber !== organizationNumber
    || saved.file !== friNettleieFileFor(organizationNumber)) {
    return { state: 'unavailable', reason: 'no_matching_tariff_file' };
  }
  try {
    return readNorwayCapacityTariff(parseFriNettleieYaml(saved.text), organizationNumber, tariffGroup, monthKey);
  } catch {
    return { state: 'unavailable', reason: 'unreadable_tariff_file' };
  }
}

function selectMonthPeriod(
  periods: Record<string, unknown>[], start: string, next: string,
): Record<string, unknown> | null {
  const overlapping = periods.filter((entry) => (
    String(entry.gyldig_fra) < next && (entry.gyldig_til == null || String(entry.gyldig_til) > start)
  ));
  const period = overlapping[0];
  if (overlapping.length !== 1 || !period || String(period.gyldig_fra) > start
    || (period.gyldig_til != null && String(period.gyldig_til) < next)) return null;
  return period;
}

function readBoundaries(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const thresholds: unknown[] = value;
  const values = thresholds.map((entry) => isUnknownRecord(entry) ? entry.terskel : null);
  if (!values.every((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)) {
    return null;
  }
  const boundaries = [...values].sort((a, b) => a - b);
  const duplicate = boundaries.some((entry, index) => index > 0 && entry === boundaries[index - 1]);
  if (boundaries[0] !== 0 || duplicate) return null;
  return boundaries;
}

function normalizePeriodDates(period: Record<string, unknown>): Record<string, unknown> {
  return {
    ...period,
    gyldig_fra: typeof period.gyldig_fra === 'string' ? period.gyldig_fra.slice(0, 10) : period.gyldig_fra,
    gyldig_til: typeof period.gyldig_til === 'string' ? period.gyldig_til.slice(0, 10) : period.gyldig_til,
  };
}

function visiblyOutsideMonth(period: Record<string, unknown>, start: string, next: string): boolean {
  if (isDate(period.gyldig_til) && period.gyldig_til <= start) return true;
  return isDate(period.gyldig_fra) && period.gyldig_fra >= next;
}
