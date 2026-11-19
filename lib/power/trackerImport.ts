import { accrueCapacityQuarter, type CapacityQuarterTracking } from './capacityQuarterTracking';
import { IMPORT_GAP_MIN_MS, resolveGapImport, resolveNextImportCounter } from './importCounter';
import { calculateEnergyAcrossBoundaries } from './trackerEnergy';
import type { ImportCounterAnchor, RecordPowerSampleParams } from './trackerTypes';

const HOUR_MS = 3_600_000;

/** What one sample booked as whole-home import for the interval since the sample before it. */
export type SampleImportAccrual = {
  /** From when the interval was filled from the held reading; the sample before it unless a gap was recovered. */
  heldFromMs: number;
  /** W the meter's counter vouches for from the previous sample up to `heldFromMs`; 0 when nothing was recovered. */
  recoveredW: number;
  importCounter: ImportCounterAnchor | undefined;
  capacityQuarter: CapacityQuarterTracking['quarter'];
  capacityMonthlyPeak: CapacityQuarterTracking['monthlyPeak'];
};

/**
 * Book the whole-home import between the previous sample and this one into the
 * hourly buckets and the tariff quarters: the previous reading held across the
 * interval, except that across a gap the meter's import counter, where it can
 * be trusted, says what the home imported, and the held reading fills only
 * what the counter does not reach (`lib/power/importCounter.ts`).
 *
 * Recovery changes what the gap books, never whether it is reliable: the
 * counter gives the gap's total, not how it split across an hour boundary, so
 * a gap that crosses one stays flagged with its estimate booked.
 */
export function accrueSampleImport(
  params: RecordPowerSampleParams,
  nowMs: number,
  budgetKWh: number | null,
  buckets: Map<string, number>,
  budgets: Map<string, number>,
): SampleImportAccrual {
  const { state, timeZone } = params;
  const previousTs = state.lastTimestamp as number;
  const previousPower = state.lastPowerW as number;
  // Floor at 0: this is the BILLED total energy bucket and billed kWh can't decrease.
  // On the homey_energy source the net `cumulative.W` goes negative during solar export;
  // `lastPowerW` keeps that signed value for the capacity guard (export legitimately
  // grows headroom), but it must not subtract kWh from the total bucket.
  const heldPowerW = Math.max(0, previousPower);
  const recovered = nowMs - previousTs > IMPORT_GAP_MIN_MS
    ? resolveGapImport(state, params.importCounter, previousTs, nowMs)
    : null;
  const heldFromMs = recovered?.coveredUntilMs ?? previousTs;
  const recoveredW = recovered === null ? 0 : (recovered.energyKWh * 1000) / ((heldFromMs - previousTs) / HOUR_MS);

  calculateEnergyAcrossBoundaries({
    startTs: previousTs, endTs: heldFromMs, powerW: recoveredW, buckets, budgets, budgetKWh,
  });
  calculateEnergyAcrossBoundaries({
    startTs: heldFromMs, endTs: nowMs, powerW: heldPowerW, buckets, budgets, budgetKWh,
  });
  let importKWh = 0;
  for (const kWh of buckets.values()) importKWh += kWh;

  const recoveredQuarter = accrueCapacityQuarter(
    state.capacityQuarter, state.capacityMonthlyPeak, previousTs, heldFromMs, recoveredW, timeZone,
  );
  const { quarter, monthlyPeak } = accrueCapacityQuarter(
    recoveredQuarter.quarter, recoveredQuarter.monthlyPeak, heldFromMs, nowMs, previousPower, timeZone,
  );
  return {
    heldFromMs,
    recoveredW,
    importCounter: resolveNextImportCounter(state.importCounter, params.importCounter, {
      importKWh, heldFromMs, endMs: nowMs, heldPowerW,
    }),
    capacityQuarter: quarter,
    capacityMonthlyPeak: monthlyPeak,
  };
}
