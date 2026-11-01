/**
 * Corrections for grid companies whose tariff as filed with NVE differs from
 * the tariff they publish and bill. Each entry names the company, what its own
 * price page says, and what NVE serves instead; remove the entry once NVE
 * serves the published tariff.
 *
 * Lnett AS: the day rate applies Monday to Friday 06–22, and Saturday, Sunday
 * and holidays use the night/weekend rate all day (l-nett.no, "Priser og
 * vilkår privat", 2026). NVE serves the day rate on weekends too (checked
 * 2026-10-25), so every weekend hour is priced at that day's lowest rate.
 * Holidays are not modelled anywhere in the tariff, so they keep NVE's rate.
 *
 * Elvia AS: from 2026-07-01 the energy rate is 46.40 by day and 31.40 at
 * night and weekends, all taxes included (elvia.no, tariffblad 1.0 "Standard
 * nettleietariff for forbrukerkunder", 01.07.2026). NVE still serves the
 * January rates, 36.40 and 26.40 (checked 2026-11-01), so each served rate is
 * replaced by the published one. Only those exact rates are replaced, and only
 * in 2026, so a corrected filing or next year's tariff passes through as NVE
 * serves it.
 */
const WEEKEND_AT_NIGHT_RATE_ORGANIZATION_NUMBERS: ReadonlySet<string> = new Set(['980038408']);

type EnergyRate = { exVat: number; incVat: number };
type RateReplacement = { served: EnergyRate; published: EnergyRate };
type DatedRateReplacements = { fromDateKey: string; toDateKey: string; replacements: RateReplacement[] };

// NVE's ex-VAT energy component carries the Enova fee; its incl-VAT one adds
// the consumption tax and VAT (see `buildCombinedHourlyPricesNorway`).
const RATE_REPLACEMENTS_BY_ORGANIZATION_NUMBER: ReadonlyMap<string, DatedRateReplacements> = new Map([
  ['980489698', {
    fromDateKey: '2026-07-01',
    toDateKey: '2026-12-31',
    replacements: [
      { served: { exVat: 21.99, incVat: 36.4 }, published: { exVat: 29.99, incVat: 46.4 } },
      { served: { exVat: 13.99, incVat: 26.4 }, published: { exVat: 17.99, incVat: 31.4 } },
    ],
  }],
]);

/**
 * Every grid company with a correction. `npm run check:nve-tariffs` probes
 * each one against NVE and fails once its correction changes nothing.
 */
export const NVE_CORRECTED_ORGANIZATION_NUMBERS: readonly string[] = [
  ...WEEKEND_AT_NIGHT_RATE_ORGANIZATION_NUMBERS,
  ...RATE_REPLACEMENTS_BY_ORGANIZATION_NUMBER.keys(),
];

const SATURDAY = 6;
const SUNDAY = 0;

const isWeekendDateKey = (dateKey: string): boolean => {
  const weekday = new Date(`${dateKey.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return weekday === SATURDAY || weekday === SUNDAY;
};

const energyFeeExVat = (entry: Record<string, unknown>): number | null => (
  typeof entry.energyFeeExVat === 'number' && Number.isFinite(entry.energyFeeExVat) ? entry.energyFeeExVat : null
);

const priceWeekendAtNightRate = (
  entries: Array<Record<string, unknown>>,
  dateKey: string,
): Array<Record<string, unknown>> => {
  if (!isWeekendDateKey(dateKey)) return entries;
  const nightRate = entries.reduce<Record<string, unknown> | null>((lowest, entry) => {
    const fee = energyFeeExVat(entry);
    if (fee === null) return lowest;
    return lowest === null || fee < (energyFeeExVat(lowest) ?? Infinity) ? entry : lowest;
  }, null);
  if (nightRate === null) return entries;
  return entries.map((entry) => ({
    ...entry,
    energyFeeExVat: nightRate.energyFeeExVat,
    energyFeeIncVat: nightRate.energyFeeIncVat,
  }));
};

const replaceServedRates = (
  entries: Array<Record<string, unknown>>,
  dated: DatedRateReplacements,
  dateKey: string,
): Array<Record<string, unknown>> => {
  const day = dateKey.slice(0, 10);
  if (day < dated.fromDateKey || day > dated.toDateKey) return entries;
  return entries.map((entry) => {
    const replacement = dated.replacements.find(({ served }) => (
      entry.energyFeeExVat === served.exVat && entry.energyFeeIncVat === served.incVat
    ));
    if (replacement === undefined) return entry;
    return {
      ...entry,
      energyFeeExVat: replacement.published.exVat,
      energyFeeIncVat: replacement.published.incVat,
    };
  });
};

/**
 * One day of normalized NVE rows for `organizationNumber`, corrected where
 * the company's NVE filing is known to differ from its published tariff.
 */
export const correctNveGridTariffDay = (
  entries: Array<Record<string, unknown>>,
  organizationNumber: string,
  dateKey: string,
): Array<Record<string, unknown>> => {
  if (WEEKEND_AT_NIGHT_RATE_ORGANIZATION_NUMBERS.has(organizationNumber)) {
    return priceWeekendAtNightRate(entries, dateKey);
  }
  const dated = RATE_REPLACEMENTS_BY_ORGANIZATION_NUMBER.get(organizationNumber);
  return dated === undefined ? entries : replaceServedRates(entries, dated, dateKey);
};
