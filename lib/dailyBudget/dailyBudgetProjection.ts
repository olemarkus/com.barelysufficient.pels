// Single source of truth for the daily-budget chart's reference curve,
// projection, and verdict. The Budget Progress chart, the hero strip, the
// plan_budget widget header, and the status verdict all read this one bundle so
// they can never disagree (the historical 43.6-vs-48.1 divergence came from
// three independent re-derivations).
//
// Pure math, no I/O, no settings-UI imports — unit-tested against bare arrays.
//
// Key concepts:
//  - budgetPaceCumKWh: the STABLE original-day-start budget spread across the
//    day = dailyBudgetKWh × normalised day-start profile weights, cumulative.
//    It sums to (and ends at) the cap and does NOT re-pace as the user under/
//    over-spends, so "below the line" genuinely means "ahead of pace".
//  - projectionCumKWh: where the day lands if the user continues at their
//    current RELATIVE pace — actuals to date, then the remaining pace shape
//    scaled by the running adherence ratio (actual-so-far ÷ pace-so-far). A
//    thrifty day projects under the cap; an over-spending day projects over it.
//  - cost arrays are in the price minor unit (e.g. øre); the consumer applies
//    the shared CostDisplay divisor (øre→kr ÷100). null where un-priceable.

import { clamp } from '../utils/mathUtils';

export type BudgetStatus = 'within' | 'tight' | 'over';

export type BudgetProjectionInput = {
  /** Active daily budget (kWh). */
  dailyBudgetKWh: number;
  /** Normalised day-start profile weights (sum ≈ 1), one per bucket. */
  weights: number[];
  /** Measured kWh per bucket; entries past currentBucketIndex are ignored. */
  actualKWh: number[];
  /** Index of the in-progress bucket; buckets < this are fully elapsed. */
  currentBucketIndex: number;
  /** Elapsed fraction (0..1) of the in-progress bucket; defaults to 1 (whole). */
  currentBucketProgress?: number;
  /** Per-bucket price in the minor unit (øre/kWh); null where unknown. */
  prices?: Array<number | null>;
};

export type BudgetProjection = {
  budgetPaceCumKWh: number[];
  projectionCumKWh: number[];
  /** Cumulative cost of actuals so far (minor unit); null entries past "now". */
  actualCostCumMinor: Array<number | null>;
  /** Cumulative cost of the budget pace (minor unit); null when any bucket unpriced. */
  budgetPaceCostCumMinor: Array<number | null>;
  /** Cumulative cost of the projection (minor unit); null when any bucket unpriced. */
  projectionCostCumMinor: Array<number | null>;
  endOfDayKWh: number;
  /** Projected end-of-day cost (minor unit); null if any energy bucket lacks a price. */
  endOfDayCostMinor: number | null;
  status: BudgetStatus;
};

const EPSILON = 1e-9;
const MAX_PACE_RATIO = 3;

const round3 = (value: number): number => Number(value.toFixed(3));

const cumulative = (increments: number[]): number[] => {
  let total = 0;
  return increments.map((value) => {
    total += Number.isFinite(value) ? value : 0;
    return round3(total);
  });
};

/** Budget verdict tolerance: at least 0.1 kWh, or 1% of the budget. */
export const budgetTolerance = (dailyBudgetKWh: number): number => (
  Math.max(0.1, dailyBudgetKWh * 0.01)
);

export const resolveBudgetStatus = (
  projectedKWh: number,
  dailyBudgetKWh: number,
): BudgetStatus => {
  if (dailyBudgetKWh <= 0) return 'within';
  const tolerance = budgetTolerance(dailyBudgetKWh);
  if (projectedKWh > dailyBudgetKWh + tolerance) return 'over';
  if (projectedKWh >= dailyBudgetKWh - tolerance) return 'tight';
  return 'within';
};

// Map a fixed 24h profile (indexed by local hour) onto the actual local-day
// buckets, which are 23 or 25 long on DST transition days. Each bucket takes the
// profile weight for its local hour ("HH:MM" label); buildBudgetProjection
// re-normalises, so only relative weights matter. A no-op when lengths already
// match (the common 24h day and the bucket-sized plan-weight fallback).
export const alignWeightsToBuckets = (
  weights: number[],
  bucketLocalLabels: string[],
): number[] => {
  if (weights.length === bucketLocalLabels.length) return weights;
  return bucketLocalLabels.map((label) => {
    const hour = Number.parseInt(String(label).slice(0, 2), 10);
    return Number.isFinite(hour) ? (weights[hour] ?? 0) : 0;
  });
};

export const buildBudgetProjection = (input: BudgetProjectionInput): BudgetProjection => {
  const { dailyBudgetKWh, weights, actualKWh, currentBucketIndex, prices } = input;
  const progress = clamp(input.currentBucketProgress ?? 1, 0, 1);
  const n = weights.length;
  const budget = Number.isFinite(dailyBudgetKWh) && dailyBudgetKWh > 0 ? dailyBudgetKWh : 0;

  // Stable day-start pace increments: budget spread by the normalised profile.
  const weightSum = weights.reduce((sum, w) => sum + (Number.isFinite(w) ? w : 0), 0);
  const paceInc = weights.map((w) => (
    weightSum > EPSILON ? (Number.isFinite(w) ? w : 0) / weightSum * budget : 0
  ));
  const budgetPaceCumKWh = cumulative(paceInc);

  // Measured buckets 0..cur (cur is the in-progress bucket; its actual is the
  // partial usage so far this hour).
  const cur = clamp(currentBucketIndex, -1, n - 1);
  const actualInc = paceInc.map((_, index) => (
    index <= cur && Number.isFinite(actualKWh[index]) ? actualKWh[index] : 0
  ));

  // Adherence ratio = actuals so far ÷ pace allowance through *now*. "Now" is the
  // fraction of the current bucket that has elapsed — dividing by the FULL
  // current-bucket pace would bias the ratio low early in the hour.
  const actualSoFar = actualInc.reduce((sum, v) => sum + v, 0);
  const paceBeforeCur = cur >= 1 ? (budgetPaceCumKWh[cur - 1] ?? 0) : 0;
  const paceSoFar = cur >= 0 ? paceBeforeCur + (paceInc[cur] ?? 0) * progress : 0;
  const ratio = paceSoFar > EPSILON ? clamp(actualSoFar / paceSoFar, 0, MAX_PACE_RATIO) : 1;

  // Projection: measured buckets to date; the current bucket adds its REMAINING
  // fraction at the ratio; future buckets at the ratio.
  const projInc = paceInc.map((pace, index) => {
    if (index < cur) return actualInc[index];
    if (index === cur) return actualInc[index] + pace * (1 - progress) * ratio;
    return pace * ratio;
  });
  const projectionCumKWh = cumulative(projInc);

  const endOfDayKWh = projectionCumKWh.length ? projectionCumKWh[projectionCumKWh.length - 1] : 0;
  const status = resolveBudgetStatus(endOfDayKWh, budget);

  // Cost arrays (minor unit). Null the whole projected/pace cost if any
  // energy-bearing bucket lacks a price (honest: can't total what we can't price).
  const priceAt = (index: number): number | null => {
    const p = prices?.[index];
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  };
  const costCum = (increments: number[], onlyElapsed: boolean): {
    cum: Array<number | null>;
    total: number | null;
  } => {
    let running = 0;
    let priceable = true;
    const cum = increments.map((inc, index) => {
      if (onlyElapsed && index > cur) return null;
      const price = priceAt(index);
      if (inc > EPSILON && price === null) priceable = false;
      running += (price ?? 0) * inc;
      return round3(running);
    });
    return { cum, total: priceable ? round3(running) : null };
  };

  const actual = costCum(actualInc, true);
  const pace = costCum(paceInc, false);
  const projection = costCum(projInc, false);

  return {
    budgetPaceCumKWh,
    projectionCumKWh,
    // All three cost series null the WHOLE series when any energy-bearing
    // bucket is un-priceable — never silently treat a missing price as 0, which
    // would under-report cost without a null signal.
    actualCostCumMinor: actual.total === null ? actual.cum.map(() => null) : actual.cum,
    budgetPaceCostCumMinor: pace.total === null ? pace.cum.map(() => null) : pace.cum,
    projectionCostCumMinor: projection.total === null ? projection.cum.map(() => null) : projection.cum,
    endOfDayKWh,
    endOfDayCostMinor: projection.total,
    status,
  };
};
