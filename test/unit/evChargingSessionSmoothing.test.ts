import type { PriceHorizonEntry } from '../../packages/planner-types/src/priceHorizon';
import type { DeferredObjectivePlanInterval } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { planDeferredObjectiveHorizon } from '../../lib/objectives/deferredObjectives/horizonPlanner';
import { smoothEvChargingPlan } from '../../lib/objectives/deferredObjectives/evChargingSessionSmoothing';
import type {
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveHorizonInput,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveStep,
} from '../../lib/objectives/deferredObjectives/types';

const START_MS = Date.UTC(2026, 10, 14, 0);
const QUARTER_MS = 15 * 60_000;
const STEPS: DeferredObjectiveStep[] = [
  { id: 'off', usefulPowerKw: 0, admissionPowerKw: 0 },
  { id: 'charge', usefulPowerKw: 2, admissionPowerKw: 2 },
];

const scenario = (
  prices: readonly number[],
  options: {
    energyKWh?: number;
    moneyPrices?: readonly number[];
    steps?: DeferredObjectiveStep[];
    bucketOverrides?: Readonly<Record<number, Partial<DeferredObjectiveHorizonBucket>>>;
    deadlineMarginMs?: number;
    fullyReserved?: boolean;
  } = {},
) => {
  const steps = options.steps ?? STEPS;
  const priceHorizon: PriceHorizonEntry[] = prices.map((price, index) => ({
    startMs: START_MS + index * QUARTER_MS,
    endMs: START_MS + (index + 1) * QUARTER_MS,
    price,
    moneyPrice: options.moneyPrices?.[index] ?? price,
  }));
  const input: DeferredObjectiveHorizonInput = {
    nowMs: START_MS,
    objective: {
      id: 'ev-energy-task', kind: 'energy', enforcement: 'soft',
      energyNeededKWh: options.energyKWh ?? 1,
      deadlineAtMs: START_MS + prices.length * QUARTER_MS,
      deadlineMarginMs: options.deadlineMarginMs ?? 0,
      fullyReserved: options.fullyReserved ?? false,
    },
    steps,
    buckets: priceHorizon.map((period, index) => ({
      id: new Date(period.startMs).toISOString(), startMs: period.startMs, endMs: period.endMs, price: period.price,
      ...options.bucketOverrides?.[index],
    })),
    powerLimit: { kind: 'limited', admissionCeilingKw: null },
    commitment: { kind: 'uncommitted' },
    aheadOfHourMilestone: false,
  };
  const plan = planDeferredObjectiveHorizon(input);
  return {
    plan, steps, priceHorizon, input,
    smooth: (commitment?: DeferredObjectivePlanInterval[]) => (
      smoothEvChargingPlan(plan, steps, priceHorizon, commitment)
    ),
  };
};

const energy = (plan: DeferredObjectiveHorizonPlan): number => plan.plannedBuckets.reduce(
  (sum, bucket) => sum + bucket.plannedUsefulEnergyKWh, 0,
);

const runCount = (plan: DeferredObjectiveHorizonPlan): number => {
  let runs = 0;
  let previousEnd: number | undefined;
  for (const bucket of plan.plannedBuckets.filter((candidate) => candidate.booked)) {
    if (previousEnd !== bucket.startMs) runs += 1;
    previousEnd = bucket.endMs;
  }
  return runs;
};

const bookedQuarters = (plan: DeferredObjectiveHorizonPlan): number[] => plan.plannedBuckets
  .filter((bucket) => bucket.booked)
  .map((bucket) => (bucket.startMs - START_MS) / QUARTER_MS);

const cost = (
  plan: DeferredObjectiveHorizonPlan,
  prices: readonly PriceHorizonEntry[],
  field: 'price' | 'moneyPrice',
): number => plan.plannedBuckets.reduce((sum, bucket) => {
  const period = prices.find((candidate) => candidate.startMs <= bucket.startMs && candidate.endMs >= bucket.endMs);
  if (!period) throw new Error('Fixture price coverage is incomplete');
  return sum + bucket.plannedUsefulEnergyKWh * period[field];
}, 0);

describe('EV scheduled charging session smoothing', () => {
  it('does not smooth subinterval bookings from a native hourly price source', () => {
    const fixture = scenario([1, 1.08, 1]);
    expect(runCount(fixture.smooth())).toBe(1);
    const sourceBucketId = new Date(START_MS).toISOString();
    const hourlyPlan = { ...fixture.plan,
      plannedBuckets: fixture.plan.plannedBuckets.map((bucket) => ({ ...bucket, sourceBucketId })) };
    const hourlyPrices = [{ startMs: START_MS, endMs: START_MS + 60 * 60_000, price: 1, moneyPrice: 1 }];
    expect(smoothEvChargingPlan(hourlyPlan, fixture.steps, hourlyPrices, undefined)).toBe(hourlyPlan);
  });

  it('keeps the planner rung when the supplied physical ladder is not sorted', () => {
    const fixture = scenario([1, 1.08, 1], {
      steps: [{ id: 'fast', usefulPowerKw: 4, admissionPowerKw: 4 }, ...STEPS],
    });
    expect(fixture.smooth().expectedStepId).toBe('charge');
  });

  it('moves delivery into a short gap, removes the cheap donor booking and conserves energy', () => {
    const fixture = scenario([1, 1.08, 1]);
    const original = structuredClone(fixture.plan);
    const smoothed = fixture.smooth();

    expect(bookedQuarters(fixture.plan)).toEqual([0, 2]);
    expect(bookedQuarters(smoothed)).toEqual([0, 1]);
    expect(runCount(smoothed)).toBe(1);
    expect(energy(smoothed)).toBeCloseTo(energy(fixture.plan), 12);
    expect(smoothed.plannedUsefulEnergyKWh).toBe(fixture.plan.plannedUsefulEnergyKWh);
    expect(smoothed.plannedBuckets.filter((bucket) => bucket.booked).every((bucket) => bucket.keepCharging)).toBe(true);
    expect(smoothed.plannedBuckets[2]?.plannedAdmissionPowerKw ?? 0).toBe(0);
    expect(fixture.plan).toEqual(original);
  });

  it('takes donor energy from the tail without creating a hole in its remaining run', () => {
    const fixture = scenario([1, 1.08, 1, 1], { energyKWh: 1.5 });
    const smoothed = fixture.smooth();

    expect(bookedQuarters(smoothed)).toEqual([0, 1, 2]);
    expect(energy(smoothed)).toBeCloseTo(1.5, 12);
    expect(smoothed.plannedBuckets[3]?.plannedUsefulEnergyKWh).toBe(0);
  });

  it('preserves unrelated opportunistic zero-energy bookings', () => {
    const fixture = scenario([1, 1.08, 1, 10, 0.5], {
      bucketOverrides: { 4: { maxUsefulEnergyKWh: 0 } },
    });
    expect(fixture.plan.plannedBuckets[4]).toMatchObject({ booked: true, plannedUsefulEnergyKWh: 0 });
    const smoothed = fixture.smooth();
    expect(bookedQuarters(smoothed)).toEqual([0, 1, 4]);
    expect(smoothed.plannedBuckets[4]).toEqual(fixture.plan.plannedBuckets[4]);
  });

  it('supports a multi-rung charger when the booked runs use the same rung', () => {
    const fixture = scenario([1, 1.08, 1], {
      steps: [...STEPS, { id: 'fast', usefulPowerKw: 4, admissionPowerKw: 4 }],
    });
    expect(bookedQuarters(fixture.smooth())).toEqual([0, 1]);
  });

  it('keeps a gap whose added cost would exceed five percent', () => {
    const fixture = scenario([1, 1.12, 1]);
    expect(fixture.smooth()).toEqual(fixture.plan);
  });

  it('accepts a bridge exactly at the five-percent total-cost boundary', () => {
    expect(bookedQuarters(scenario([1, 1.1, 1]).smooth())).toEqual([0, 1]);
  });

  it.each([
    { prices: [1, 1.08, 1], moneyPrices: [1, 2, 1] },
    { prices: [1, 1.12, 1], moneyPrices: [1, 1.01, 1] },
  ])('enforces both import-money and solar-adjusted planning cost bounds: %j', (options) => {
    const fixture = scenario(options.prices, { moneyPrices: options.moneyPrices });
    expect(fixture.smooth()).toEqual(fixture.plan);
  });

  it.each([[0, 0.01, 0], [-1, -0.92, -1]])(
    'does not spend extra money against a zero or negative baseline: %j', (...prices) => {
      const fixture = scenario(prices);
      expect(fixture.smooth()).toEqual(fixture.plan);
    },
  );

  it.each([0, -1])('can bridge without increasing a nonpositive money cost (%s)', (moneyPrice) => {
    const fixture = scenario([1, 1.08, 1], { moneyPrices: [moneyPrice, moneyPrice, moneyPrice] });
    expect(bookedQuarters(fixture.smooth())).toEqual([0, 1]);
  });

  it('shares one original five-percent allowance across several gaps', () => {
    const fixture = scenario([1, 1.14, 1, 10, 10, 1, 1.14, 1, 10, 10, 1, 1.14, 1, 1], { energyKWh: 3.5 });
    const smoothed = fixture.smooth();

    // Each independent bridge adds 2% of the original cost. Two fit; a third does not.
    expect(runCount(smoothed)).toBe(runCount(fixture.plan) - 2);
    expect(energy(smoothed)).toBeCloseTo(energy(fixture.plan), 12);
    expect(cost(smoothed, fixture.priceHorizon, 'moneyPrice'))
      .toBeLessThanOrEqual(cost(fixture.plan, fixture.priceHorizon, 'moneyPrice') * 1.05);
    expect(cost(smoothed, fixture.priceHorizon, 'price'))
      .toBeLessThanOrEqual(cost(fixture.plan, fixture.priceHorizon, 'price') * 1.05);
  });

  it('retains the original plan when a gap price is unavailable', () => {
    const fixture = scenario([1, 1.08, 1]);
    const missingGap = fixture.priceHorizon.filter((_, index) => index !== 1);
    expect(smoothEvChargingPlan(fixture.plan, fixture.steps, missingGap, undefined)).toEqual(fixture.plan);
  });

  it('does not bridge a gap longer than fifteen minutes', () => {
    const fixture = scenario([1, 1.08, 1.08, 1]);
    expect(fixture.smooth()).toEqual(fixture.plan);
  });

  it('does not bridge when the gap cannot carry the full charging rung', () => {
    const fixture = scenario([1, 1.08, 1], {
      bucketOverrides: { 1: { maxUsefulEnergyKWh: 0.25 } },
    });
    expect(fixture.smooth()).toEqual(fixture.plan);
  });

  it('does not join runs that reserve different charging rungs', () => {
    const fixture = scenario([1, 1.08, 1], {
      energyKWh: 1.5,
      fullyReserved: true,
      steps: [...STEPS, { id: 'fast', usefulPowerKw: 4, admissionPowerKw: 4 }],
      bucketOverrides: {
        0: { reservedHeadroomKw: 2 }, 1: { reservedHeadroomKw: 2 }, 2: { reservedHeadroomKw: 4 },
      },
    });
    expect(fixture.smooth()).toEqual(fixture.plan);
  });

  it('leaves an incomplete or deadline-reserve allocation alone', () => {
    const incomplete = scenario([1, 1.08, 1], { energyKWh: 2 });
    expect(incomplete.plan.unplannedUsefulEnergyKWh).toBeGreaterThan(0);
    expect(incomplete.smooth()).toEqual(incomplete.plan);

    const reserve = scenario([1, 1.08, 1], { deadlineMarginMs: QUARTER_MS, energyKWh: 1.5 });
    expect(reserve.plan.usesDeadlineReserve).toBe(true);
    expect(reserve.smooth()).toEqual(reserve.plan);
  });

  it('does not redistribute an existing commitment', () => {
    const fixture = scenario([1, 1.08, 1]);
    const commitment = fixture.plan.plannedBuckets.filter((bucket) => bucket.booked).map((bucket) => ({
      startsAtMs: bucket.startMs, endsAtMs: bucket.endMs, plannedKWh: bucket.plannedUsefulEnergyKWh,
    }));
    expect(fixture.smooth(commitment)).toEqual(fixture.plan);
  });

  it('keeps opportunistic capacity available when a marked committed task cannot finish', () => {
    const fixture = scenario([1, 1.08, 1], { energyKWh: 2 });
    const commitment: DeferredObjectivePlanInterval[] = [{
      startsAtMs: START_MS, endsAtMs: START_MS + QUARTER_MS, plannedKWh: 0.5, keepCharging: true,
    }];
    const replayed = fixture.smooth(commitment);
    expect(replayed.unplannedUsefulEnergyKWh).toBeGreaterThan(0);
    expect(replayed.plannedBuckets.every((bucket) => bucket.booked)).toBe(true);
  });

  it('replays continuous coverage without rebooking the removed cheap donor at settlement', () => {
    const fixture = scenario([1, 1.08, 1]);
    const selected = fixture.smooth();
    const commitment: DeferredObjectivePlanInterval[] = selected.plannedBuckets
      .filter((bucket) => bucket.booked)
      .map((bucket) => ({
        startsAtMs: bucket.startMs, endsAtMs: bucket.endMs,
        plannedKWh: bucket.plannedUsefulEnergyKWh,
        ...(bucket.keepCharging ? { keepCharging: true as const } : {}),
      }));
    const replanned = planDeferredObjectiveHorizon({
      ...fixture.input, commitment: { kind: 'committed', hours: commitment },
    });
    expect(replanned.plannedBuckets[2]).toMatchObject({ booked: true, plannedUsefulEnergyKWh: 0 });
    const replayed = smoothEvChargingPlan(replanned, fixture.steps, fixture.priceHorizon, commitment);

    expect(bookedQuarters(replayed)).toEqual([0, 1]);
    expect(energy(replayed)).toBeCloseTo(energy(selected), 12);
    expect(replayed.plannedBuckets.filter((bucket) => bucket.booked).every((bucket) => bucket.keepCharging)).toBe(true);
  });
});
