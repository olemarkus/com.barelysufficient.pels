import type { GenerationSegment, PowerTrackerState } from './trackerTypes';
import { calculateEnergyAcrossBoundaries } from './trackerEnergy';
import { isFiniteNumber } from '../utils/appTypeGuards';

/**
 * Solar accounting helpers for the power tracker (PR-5 solar visibility).
 *
 * Owns the write-side rules for the sparse `generationBuckets` /
 * `exportBuckets` families so `tracker.ts` stays within its size budget:
 *
 * - Sparseness invariant: no zero entries are ever created, and a home with
 *   no generation signal / never-negative net never gains a solar key — the
 *   non-solar byte-identity merge gate depends on it.
 * - Generation from observed stretches only: production accrues from the
 *   stretches the production readings vouch for (`GenerationSegment`), never
 *   from one reading held across the sample interval. Net can arrive sparsely
 *   (a Flow card firing every 30 min), and a held reading then mints
 *   production that never happened. Each stretch is already bounded by the
 *   reading after it or its freshness window, so production needs no gap guard.
 * - Gap guard (export): export accrual is skipped when the interval exceeds
 *   {@link MAX_SOLAR_ACCRUAL_GAP_MS} — a silent multi-hour gap would otherwise
 *   mint the held net across the whole gap (e.g. an 8 h outage at −3 kW → 24 kWh
 *   of ghost export, priced into the money lines). Together these keep
 *   produced/exported kWh an honest floor.
 */

/**
 * Producer-resolved gross generation for a sample; `undefined` = no signal.
 * Finiteness-gated at this persistence boundary so junk can never latch into
 * `lastGenerationW`, the live "producing now" reading the settings UI shows.
 */
export const resolveSampleGenerationW = (generationW: unknown): number | undefined => (
  isFiniteNumber(generationW) ? Math.max(0, generationW) : undefined
);

/**
 * Longest sample interval export will integrate across — the same
 * 60-minute rule `resolveUnreliablePeriods` uses to flag a gap as unreliable.
 * The billed import bucket integrates such gaps anyway and FLAGS them via
 * `unreliablePeriods`; the solar families have no unreliable flag of their own
 * yet, so they skip instead — extending that awareness to the solar bucket
 * families is what would let them integrate a flagged gap. Deliberate
 * trade-off: across a skipped gap the per-hour identity
 * importKWh − exportKWh ≡ net no longer holds (import accrues, export does
 * not) — under-counting an unobserved interval is the honest floor, minting
 * held watts across it is not.
 */
const MAX_SOLAR_ACCRUAL_GAP_MS = 60 * 60 * 1000;

/**
 * Accrues the interval [startTs, endTs] into the solar bucket maps.
 *
 * EXPORT: the integral of max(0, −net). `lastPowerW` deliberately keeps the
 * SIGNED net value (the billed total bucket floors it at 0 — see the clamp in
 * `recordPowerSample`), so a negative held sample IS grid export. Within a
 * normally-sampled interval, importKWh − exportKWh ≡ net energy by
 * construction (see the gap trade-off on {@link MAX_SOLAR_ACCRUAL_GAP_MS}).
 * Export stays on the net clock because it is the complement of the billed
 * import bucket, which integrates the same held net.
 *
 * GENERATION: the observed production stretches, clipped to the interval.
 * Zero-generation intervals (night) produce no stretch, so the family stays
 * sparse.
 */
export const accrueSolarSample = (params: {
  previousPowerW: number;
  generationSegments: readonly GenerationSegment[];
  startTs: number;
  endTs: number;
  exportBuckets: Map<string, number>;
  generationBuckets: Map<string, number>;
}): void => {
  const {
    previousPowerW,
    generationSegments,
    startTs,
    endTs,
    exportBuckets,
    generationBuckets,
  } = params;
  accrueGenerationSegments(generationSegments, startTs, endTs, generationBuckets);
  if (endTs - startTs > MAX_SOLAR_ACCRUAL_GAP_MS) return;
  const exportPowerW = Math.max(0, -previousPowerW);
  if (exportPowerW > 0) {
    calculateEnergyAcrossBoundaries({
      startTs,
      endTs,
      powerW: exportPowerW,
      buckets: exportBuckets,
      budgets: new Map(),
      budgetKWh: null,
    });
  }
};

/**
 * Integrates each production stretch, clipped to the sample interval
 * [startTs, endTs], into the generation buckets. Clipping is what keeps two
 * consecutive samples from counting the same stretch twice: the history handed
 * over can reach back past this interval's start.
 */
const accrueGenerationSegments = (
  segments: readonly GenerationSegment[],
  startTs: number,
  endTs: number,
  generationBuckets: Map<string, number>,
): void => {
  for (const segment of segments) {
    const segmentStartTs = Math.max(segment.startMs, startTs);
    const segmentEndTs = Math.min(segment.endMs, endTs);
    if (segmentEndTs <= segmentStartTs) continue;
    calculateEnergyAcrossBoundaries({
      startTs: segmentStartTs,
      endTs: segmentEndTs,
      powerW: segment.watts,
      buckets: generationBuckets,
      budgets: new Map(),
      budgetKWh: null,
    });
  }
};

type SolarFamilyAggregate = {
  buckets?: Record<string, number>;
  dailyTotals: Record<string, number>;
};

type SolarAggregateForType = (
  buckets?: Record<string, number>,
  dailyTotals?: Record<string, number>,
  hourlyAverages?: Record<string, { sum: number; count: number }>,
) => SolarFamilyAggregate;

const hasFamilyHistory = (
  buckets?: Record<string, number>,
  dailyTotals?: Record<string, number>,
): boolean => (
  Object.keys(buckets || {}).length > 0 || Object.keys(dailyTotals || {}).length > 0
);

/**
 * Prune-pass patch for the two solar families. Gated on a family carrying ANY
 * history so a non-solar home's state passes through with the fields
 * untouched/absent (the byte-identity merge gate). The hourlyAverages slice of
 * `aggregateForType` is deliberately DISCARDED — no consumer exists for
 * typical-day generation/export averages, and speculative persisted state
 * contradicts the boundary discipline. Retention is inherited from the caller
 * (30 d hourly folded into Homey-local-day totals, 365 d daily) — DST 23/25 h
 * days are correct by construction via `resolveDayHourKey`.
 */
export const buildSolarAggregatePatch = (
  state: PowerTrackerState,
  aggregateForType: SolarAggregateForType,
): Partial<PowerTrackerState> => {
  const familyPatch = (
    bucketsKey: 'generationBuckets' | 'exportBuckets',
    dailyTotalsKey: 'generationDailyTotals' | 'exportDailyTotals',
  ): Partial<PowerTrackerState> => {
    const buckets = state[bucketsKey];
    const dailyTotals = state[dailyTotalsKey];
    if (!hasFamilyHistory(buckets, dailyTotals)) return {};
    const aggregate = aggregateForType(buckets, dailyTotals, undefined);
    return {
      ...(aggregate.buckets !== undefined ? { [bucketsKey]: aggregate.buckets } : {}),
      [dailyTotalsKey]: aggregate.dailyTotals,
    };
  };
  return {
    ...familyPatch('generationBuckets', 'generationDailyTotals'),
    ...familyPatch('exportBuckets', 'exportDailyTotals'),
  };
};
