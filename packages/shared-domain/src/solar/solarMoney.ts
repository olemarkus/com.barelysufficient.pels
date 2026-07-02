// Today's solar money, derived read-side from the tracker's kWh families and
// the REAL combined-price rows. Browser-safe, money-agnostic persistence: the
// tracker stores kWh only; every monetary figure is computed here at read time
// from `total` (import money price) and `exportPrice` — never the planning
// `budgetPrice`, which is a scheduling blend, not money.
//
// Headline semantics (design decision, PR-5 spec): the primary figure is
// AVOIDED COST — what the self-consumed kWh would have cost to import
// (selfUsed_h × total_h) — with export earnings (exported_h × exportPrice_h,
// signed) as a separate line. The two value disjoint kWh pools, so they never
// double-count. The sell-everything counterfactual is deliberately not
// computed in v1.
//
// Values are in the price rows' own minor units (øre for the Norwegian
// scheme); display scaling is the caller's job via the shared
// CostDisplay {unit, divisor} resolution.

import { isFiniteNumber } from '../numberGuards';

export type SolarMoneyPriceRow = {
  /** Hour start, ISO 8601 (any offset — joined on the epoch instant). */
  startsAt: string;
  /** Import money price for the hour (minor units per kWh). */
  total: number;
  /** Export price for the hour (minor units per kWh); may be negative (feed-in cost). */
  exportPrice?: number;
};

export type SolarMoneyToday = {
  /**
   * Grid cost avoided = Σ_h selfUsed_h × total_h over today's priced solar
   * hours, or `null` when no solar hour had an import price (→ kWh-only tier).
   */
  avoidedMinor: number | null;
  /**
   * Earned from export = Σ_h exported_h × exportPrice_h (signed — negative
   * feed-in shows negative), or `null` when no solar hour carried an export
   * price (→ avoided-only tier).
   */
  earnedMinor: number | null;
  /**
   * Solar hours today with no import price row — drives the avoided line's
   * "· some hours unpriced" suffix.
   */
  unpricedSolarHours: number;
  /**
   * Export-carrying hours today with no finite export price — its OWN axis, so
   * partial export-price coverage flags the earned line instead of silently
   * understating it (the import axis can be fully priced while the export
   * axis is not).
   */
  unpricedExportHours: number;
};

const buildPriceRowIndex = (priceRows: readonly SolarMoneyPriceRow[]): Map<number, SolarMoneyPriceRow> => {
  const rowByHourMs = new Map<number, SolarMoneyPriceRow>();
  for (const row of priceRows) {
    const startsAtMs = Date.parse(row.startsAt);
    if (!Number.isFinite(startsAtMs) || !isFiniteNumber(row.total)) continue;
    rowByHourMs.set(startsAtMs, row);
  }
  return rowByHourMs;
};

type SolarHourMoney = {
  /** selfUsed × total for an import-priced hour; null when the hour has no price row. */
  avoidedMinor: number | null;
  /** exported × exportPrice for an export-priced hour; null otherwise. */
  earnedMinor: number | null;
  /** The hour carries export the earned line cannot price. */
  unpricedExport: boolean;
};

const resolveSolarHourMoney = (
  row: SolarMoneyPriceRow | undefined,
  generatedKWh: number,
  exportedKWh: number,
): SolarHourMoney => {
  if (!row) {
    return { avoidedMinor: null, earnedMinor: null, unpricedExport: exportedKWh > 0 };
  }
  const selfUsedKWh = Math.max(0, generatedKWh - exportedKWh);
  const { exportPrice } = row;
  const exportPriced = isFiniteNumber(exportPrice);
  return {
    avoidedMinor: selfUsedKWh * row.total,
    earnedMinor: exportPriced ? exportedKWh * exportPrice : null,
    unpricedExport: !exportPriced && exportedKWh > 0,
  };
};

/**
 * Joins today's per-UTC-hour generated/exported kWh with the price rows on the
 * epoch hour-start. Self-consumption is derived PER HOUR as
 * max(0, generated − exported) so a battery-discharge export hour (exported >
 * generated) contributes 0 self-use instead of going negative.
 */
export const resolveSolarMoneyToday = (params: {
  priceRows: readonly SolarMoneyPriceRow[];
  generationKWhByHourMs: ReadonlyMap<number, number>;
  exportKWhByHourMs: ReadonlyMap<number, number>;
  todayHourStartsMs: readonly number[];
}): SolarMoneyToday => {
  const { priceRows, generationKWhByHourMs, exportKWhByHourMs, todayHourStartsMs } = params;
  const rowByHourMs = buildPriceRowIndex(priceRows);
  let avoidedMinor: number | null = null;
  let earnedMinor: number | null = null;
  let unpricedSolarHours = 0;
  let unpricedExportHours = 0;

  for (const hourMs of todayHourStartsMs) {
    const generatedKWh = generationKWhByHourMs.get(hourMs) ?? 0;
    const exportedKWh = exportKWhByHourMs.get(hourMs) ?? 0;
    if (generatedKWh <= 0 && exportedKWh <= 0) continue;
    const hour = resolveSolarHourMoney(rowByHourMs.get(hourMs), generatedKWh, exportedKWh);
    if (hour.avoidedMinor === null) unpricedSolarHours += 1;
    else avoidedMinor = (avoidedMinor ?? 0) + hour.avoidedMinor;
    if (hour.earnedMinor !== null) earnedMinor = (earnedMinor ?? 0) + hour.earnedMinor;
    if (hour.unpricedExport) unpricedExportHours += 1;
  }

  return { avoidedMinor, earnedMinor, unpricedSolarHours, unpricedExportHours };
};
