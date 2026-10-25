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
 */
const WEEKEND_AT_NIGHT_RATE_ORGANIZATION_NUMBERS: ReadonlySet<string> = new Set(['980038408']);

const SATURDAY = 6;
const SUNDAY = 0;

const isWeekendDateKey = (dateKey: string): boolean => {
  const weekday = new Date(`${dateKey.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return weekday === SATURDAY || weekday === SUNDAY;
};

const energyFeeExVat = (entry: Record<string, unknown>): number | null => (
  typeof entry.energyFeeExVat === 'number' && Number.isFinite(entry.energyFeeExVat) ? entry.energyFeeExVat : null
);

/**
 * One day of normalized NVE rows for `organizationNumber`, corrected where
 * the company's NVE filing is known to differ from its published tariff.
 */
export const correctNveGridTariffDay = (
  entries: Array<Record<string, unknown>>,
  organizationNumber: string,
  dateKey: string,
): Array<Record<string, unknown>> => {
  if (!WEEKEND_AT_NIGHT_RATE_ORGANIZATION_NUMBERS.has(organizationNumber)) return entries;
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
