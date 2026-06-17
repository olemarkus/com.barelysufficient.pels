import {
  alignWeightsToBuckets,
  buildBudgetProjection,
  resolveBudgetStatus,
} from '../../lib/dailyBudget/dailyBudgetProjection';

// Flat 24h weights (each bucket an equal share) keep the arithmetic obvious.
const flatWeights = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

// Local-day hour labels ("HH:MM"); DST fall-back repeats 02:00 (25h),
// spring-forward skips it (23h).
const hourLabels = (n: number): string[] => {
  const base = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
  if (n === 25) { const o = [...base]; o.splice(3, 0, '02:00'); return o; }
  if (n === 23) return base.filter((_, h) => h !== 2);
  return base;
};

describe('dailyBudgetProjection — stable budget pace', () => {
  it('spreads the budget by the profile and ENDS AT the cap (never above/below)', () => {
    const { budgetPaceCumKWh } = buildBudgetProjection({
      dailyBudgetKWh: 48,
      weights: flatWeights(24),
      actualKWh: Array.from({ length: 24 }, () => 0),
      currentBucketIndex: -1,
    });
    expect(budgetPaceCumKWh).toHaveLength(24);
    expect(budgetPaceCumKWh[23]).toBeCloseTo(48, 3); // ends exactly at the cap
    // monotonic ramp
    for (let i = 1; i < 24; i += 1) {
      expect(budgetPaceCumKWh[i]).toBeGreaterThanOrEqual(budgetPaceCumKWh[i - 1]);
    }
  });

  it('is stable regardless of actuals (does not re-pace as the user under-spends)', () => {
    const base = { dailyBudgetKWh: 48, weights: flatWeights(24), currentBucketIndex: 11 };
    const thrifty = buildBudgetProjection({ ...base, actualKWh: Array.from({ length: 24 }, () => 0.5) });
    const heavy = buildBudgetProjection({ ...base, actualKWh: Array.from({ length: 24 }, () => 3) });
    expect(thrifty.budgetPaceCumKWh).toEqual(heavy.budgetPaceCumKWh);
  });

  it('the projection function is length-agnostic (self-consistent arrays)', () => {
    for (const n of [23, 25]) {
      const { budgetPaceCumKWh } = buildBudgetProjection({
        dailyBudgetKWh: 50, weights: flatWeights(n), actualKWh: Array.from({ length: n }, () => 0), currentBucketIndex: -1,
      });
      expect(budgetPaceCumKWh).toHaveLength(n);
      expect(budgetPaceCumKWh[n - 1]).toBeCloseTo(50, 3);
    }
  });
});

describe('dailyBudgetProjection — DST weight alignment (the real producer path)', () => {
  it('alignWeightsToBuckets is a no-op when lengths already match', () => {
    const w = flatWeights(24);
    expect(alignWeightsToBuckets(w, hourLabels(24))).toBe(w);
  });

  it('maps fixed-24 profile weights onto 25- and 23-bucket DST days by local hour', () => {
    const w = Array.from({ length: 24 }, (_, h) => h); // distinct per hour
    const a25 = alignWeightsToBuckets(w, hourLabels(25));
    expect(a25).toHaveLength(25);
    expect(a25.filter((v) => v === 2)).toHaveLength(2); // 02:00 repeated → weight 2 twice
    const a23 = alignWeightsToBuckets(w, hourLabels(23));
    expect(a23).toHaveLength(23);
    expect(a23.includes(2)).toBe(false); // 02:00 skipped → its weight absent
  });

  it('REGRESSION: fixed-24 weights aligned to a 23h day → arrays index-align, cost is a number (not spurious null)', () => {
    // Reproduces the P0: combinedWeights is always length 24; the bucket arrays
    // are 23 on spring-forward. Aligning first keeps everything bucket-length.
    const n = 23;
    const weights = alignWeightsToBuckets(flatWeights(24), hourLabels(n));
    const actualKWh = Array.from({ length: n }, (_, i) => (i < 10 ? 1 : 0));
    const prices = Array.from({ length: n }, () => 80);
    const p = buildBudgetProjection({ dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 9, prices });
    expect(p.budgetPaceCumKWh).toHaveLength(n);
    expect(p.projectionCumKWh).toHaveLength(n);
    expect(p.budgetPaceCumKWh[n - 1]).toBeCloseTo(48, 3); // still ends at the cap
    expect(p.endOfDayCostMinor).not.toBeNull(); // all 23 real buckets priced → a real total
  });

  it('nulls the actual-cost series when an ELAPSED bucket is unpriced (no silent under-report)', () => {
    const prices: Array<number | null> = Array.from({ length: 24 }, () => 80);
    prices[3] = null; // an elapsed bucket has no price
    const actualKWh = Array.from({ length: 24 }, (_, i) => (i < 6 ? 1 : 0));
    const p = buildBudgetProjection({ dailyBudgetKWh: 48, weights: flatWeights(24), actualKWh, currentBucketIndex: 5, prices });
    expect(p.actualCostCumMinor.every((v) => v === null)).toBe(true);
  });
});

describe('dailyBudgetProjection — projection (continue-current-pace)', () => {
  const weights = flatWeights(24);

  it('a thrifty day projects UNDER the cap → status within', () => {
    // Through 12 buckets the pace allows 24 kWh; the user has used only 12 (half pace).
    const actualKWh = Array.from({ length: 24 }, (_, i) => (i < 12 ? 1 : 0));
    const p = buildBudgetProjection({ dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 11 });
    expect(p.endOfDayKWh).toBeLessThan(48);
    expect(p.endOfDayKWh).toBeCloseTo(24, 0); // half-pace all day → ~half the budget
    expect(p.status).toBe('within');
  });

  it('an on-pace day projects ≈ the cap → status tight', () => {
    const actualKWh = Array.from({ length: 24 }, (_, i) => (i < 12 ? 2 : 0)); // 24 kWh by bucket 12 = exactly pace
    const p = buildBudgetProjection({ dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 11 });
    expect(p.endOfDayKWh).toBeCloseTo(48, 0);
    expect(p.status).toBe('tight');
  });

  it('an over-spending day projects OVER the cap → status over', () => {
    const actualKWh = Array.from({ length: 24 }, (_, i) => (i < 12 ? 3 : 0)); // 36 by bucket 12 = 1.5× pace
    const p = buildBudgetProjection({ dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 11 });
    expect(p.endOfDayKWh).toBeGreaterThan(48);
    expect(p.status).toBe('over');
  });

  it('projection equals actuals on elapsed buckets', () => {
    const actualKWh = Array.from({ length: 24 }, (_, i) => (i <= 5 ? 1 : 0));
    const p = buildBudgetProjection({ dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 5 });
    expect(p.projectionCumKWh[5]).toBeCloseTo(6, 3); // 6 actual buckets × 1 kWh
  });

  it('accounts for partial current-bucket progress (no early under-bias)', () => {
    // 5 min into bucket 12 of an on-pace day; the tiny partial actual must not
    // make the projection read far under budget (the P0/Major the bots flagged).
    const actualKWh = Array.from({ length: 24 }, (_, i) => {
      if (i < 12) return 2; // 24 kWh through bucket 11 = exactly on pace
      if (i === 12) return 2 * (5 / 60); // 5 minutes into the 2 kWh current bucket
      return 0;
    });
    const partial = buildBudgetProjection({
      dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 12, currentBucketProgress: 5 / 60,
    });
    expect(partial.endOfDayKWh).toBeCloseTo(48, 0); // on pace → ~budget
    // Treating the partial bucket as whole under-projects:
    const naive = buildBudgetProjection({ dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 12 });
    expect(naive.endOfDayKWh).toBeLessThan(partial.endOfDayKWh - 1);
  });
});

describe('dailyBudgetProjection — cost', () => {
  const weights = flatWeights(24);
  const actualKWh = Array.from({ length: 24 }, (_, i) => (i < 12 ? 1 : 0));

  it('totals cost in the price minor unit when every bucket is priced', () => {
    const prices = Array.from({ length: 24 }, () => 80); // 80 øre/kWh flat
    const p = buildBudgetProjection({ dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 11, prices });
    // projection ~24 kWh × 80 øre = ~1920 øre
    expect(p.endOfDayCostMinor).not.toBeNull();
    expect(p.endOfDayCostMinor as number).toBeCloseTo(p.endOfDayKWh * 80, 0);
  });

  it('returns null projected cost when an energy-bearing bucket lacks a price', () => {
    const prices: Array<number | null> = Array.from({ length: 24 }, () => 80);
    prices[18] = null; // an evening bucket the projection fills has no price
    const p = buildBudgetProjection({ dailyBudgetKWh: 48, weights, actualKWh, currentBucketIndex: 11, prices });
    expect(p.endOfDayCostMinor).toBeNull();
    expect(p.projectionCostCumMinor.every((v) => v === null)).toBe(true);
  });
});

describe('resolveBudgetStatus', () => {
  it('classifies within / tight / over against the tolerance band', () => {
    expect(resolveBudgetStatus(40, 48)).toBe('within');
    expect(resolveBudgetStatus(47.8, 48)).toBe('tight'); // within 1% tolerance
    expect(resolveBudgetStatus(49, 48)).toBe('over');
  });
});
