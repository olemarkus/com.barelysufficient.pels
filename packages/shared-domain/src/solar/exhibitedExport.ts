import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes';

/**
 * A home "has exhibited export" once its recorded grid-export energy crosses a
 * material floor — a stable, accumulated kWh signal, never a transient watt.
 *
 * This broadens the "this home can self-consume solar surplus" gate to
 * meter-only PV homes: a string inverter with no Homey `solarpanel` device
 * (common in NL/DE) reports no production device, so `hasManagedSolarDevice` is
 * false — yet the surplus-absorb engine keys off whole-home net export
 * (`context.total < 0`), which such a home DOES exhibit. Without this signal the
 * home has a working feature but no per-device "Use solar surplus" toggle.
 *
 * Stability guarantees (why this never flickers the toggle):
 * - The tracker only creates an export bucket when net went negative (real
 *   generation feeding back), and never a zero entry, so a home that has never
 *   exported has empty families and reads false — byte-identical to the
 *   pre-existing gate for homes with neither solar signal.
 * - A one-off measurement blip contributes a fraction of a kWh and stays under
 *   the floor; a real exporting home accumulates well past it.
 * - The 365-day daily totals survive a winter export lull, so the toggle does
 *   not disappear seasonally once a home has established an export history.
 */
export const MATERIAL_EXHIBITED_EXPORT_KWH = 1;

const sumMaterialKWh = (record: Record<string, number> | undefined): number => {
  let total = 0;
  for (const value of Object.values(record ?? {})) {
    // Boundary normalization: non-finite / negative junk contributes nothing.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
};

export const hasMaterialExhibitedExport = (
  tracker: PowerTrackerState | null | undefined,
): boolean => {
  if (!tracker) return false;
  // Either retention window crossing the floor qualifies. The 365-day daily
  // totals give the stable long-horizon signal; the 30-day hourly buckets cover
  // a brand-new install whose first sunny days have not yet folded into a daily
  // total. The two windows are NOT disjoint — aged hourly export folds into the
  // daily totals, so the same energy can appear in both — but this is an OR of
  // two per-window thresholds, never a sum across them, so the overlap only ever
  // helps the gate trip at >= 1 kWh in EITHER window and can never double-count.
  return sumMaterialKWh(tracker.exportDailyTotals) >= MATERIAL_EXHIBITED_EXPORT_KWH
    || sumMaterialKWh(tracker.exportBuckets) >= MATERIAL_EXHIBITED_EXPORT_KWH;
};
