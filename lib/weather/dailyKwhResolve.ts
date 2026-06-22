import { getDateKeyStartMs, shiftDateKey } from '../utils/dateUtils';

/**
 * Resolves a local day's kWh totals from power-tracker data. The tracker only
 * folds hourly buckets into `dailyTotals` once they age past its 30-day hourly
 * retention, so recent days (everything a live midnight rollup asks about)
 * exist solely as UTC-hour buckets — sum those over the local-day window and
 * fall back to `dailyTotals` for older days (the Insights backfill path).
 */
export type DailyKwhSource = {
  buckets?: Record<string, number>;
  controlledBuckets?: Record<string, number>;
  uncontrolledBuckets?: Record<string, number>;
  dailyTotals?: Record<string, number>;
  controlledDailyTotals?: Record<string, number>;
  uncontrolledDailyTotals?: Record<string, number>;
};

export function resolveDailyKwh(params: {
  dateKey: string;
  timeZone: string;
  source: DailyKwhSource;
}): { total?: number; controlled?: number; uncontrolled?: number } {
  const { dateKey, timeZone, source } = params;
  const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
  const nextDayStartMs = getDateKeyStartMs(shiftDateKey(dateKey, 1), timeZone);
  const total = combineDisjointSums(
    sumBucketsInWindow(source.buckets, dayStartMs, nextDayStartMs),
    source.dailyTotals?.[dateKey],
  );
  const controlled = combineDisjointSums(
    sumBucketsInWindow(source.controlledBuckets, dayStartMs, nextDayStartMs),
    source.controlledDailyTotals?.[dateKey],
  );
  const uncontrolled = combineDisjointSums(
    sumBucketsInWindow(source.uncontrolledBuckets, dayStartMs, nextDayStartMs),
    source.uncontrolledDailyTotals?.[dateKey],
  );
  return {
    ...(total !== undefined ? { total } : {}),
    ...(controlled !== undefined ? { controlled } : {}),
    ...(uncontrolled !== undefined ? { uncontrolled } : {}),
  };
}

/**
 * The day straddling the tracker's 30-day prune boundary is split between the
 * two sources: pruning MOVES each aged bucket's energy into `dailyTotals`
 * hour by hour (never copies), so when both sides hold data for one dateKey
 * they are disjoint and must be summed, not preferred.
 */
function combineDisjointSums(bucketSum: number | undefined, agedTotal: number | undefined): number | undefined {
  if (bucketSum === undefined && agedTotal === undefined) return undefined;
  // Floor each side: a solar-export hour can leave a negative kWh in a persisted bucket
  // or aged daily total, which must not deflate the energy-signature day sum.
  return Math.max(0, bucketSum ?? 0) + Math.max(0, agedTotal ?? 0);
}

function sumBucketsInWindow(
  buckets: Record<string, number> | undefined,
  startMs: number,
  endMs: number,
): number | undefined {
  if (!buckets) return undefined;
  let sum = 0;
  let found = false;
  for (const [isoKey, kWh] of Object.entries(buckets)) {
    const timestampMs = Date.parse(isoKey);
    if (!Number.isFinite(timestampMs) || timestampMs < startMs || timestampMs >= endMs) continue;
    if (typeof kWh !== 'number' || !Number.isFinite(kWh)) continue;
    sum += Math.max(0, kWh); // export hours can persist a negative kWh; don't deflate the day sum
    found = true;
  }
  return found ? sum : undefined;
}
