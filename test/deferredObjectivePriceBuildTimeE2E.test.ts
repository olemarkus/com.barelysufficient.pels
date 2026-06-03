// End-to-end proof of the PRIMARY price mechanism in smart tasks: the build-time
// allocator fills CHEAPER hours first and leaves more expensive ones empty,
// comparing hours RELATIVELY (currency-invariant), not against an absolute band.
//
// Unlike the live mid-execution deferral (see
// deferredObjectivePriceDeferralE2E.test.ts), this is where the bulk of the
// "prefer cheap over expensive" behaviour lives, and it runs from RAW PRICES
// through the real producer:
//
//   raw price curve ─► buildDeferredObjectivePolicyHorizon()
//                       (carries each hour's raw price onto the horizon bucket)
//                   ─► planDeferredObjectiveHorizon()  (cheapest-first allocation)
//                   ─► applyDeferredObjectiveAdmission()  (run / idle the device)
//
// `compareBucketsForAllocation` orders hours on a currency-relative price band
// (`PRICE_BAND_MARGIN`): cheaper hours fill first, and hours within ~5% of each
// other tie and fall through to the time tiebreak (earlier first). So the energy
// lands in the cheap hours and the expensive current hour is left unbooked → the
// device idles in it. Everything is held equal across scenarios except the price
// curve, which is flipped/scaled to prove the comparison is relative, not absolute.
import { planDeferredObjectiveHorizon } from '../lib/objectives/deferredObjectives';
import { buildDeferredObjectivePolicyHorizon } from '../lib/objectives/deferredObjectives/policyHorizon';
import { applyDeferredObjectiveAdmission } from '../lib/objectives/deferredObjectives/admission';
import type { DeferredObjectiveDiagnostic } from '../lib/objectives/deferredObjectives/diagnosticsBridge';
import type {
  DeferredObjective,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveStep,
} from '../lib/objectives/deferredObjectives';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import type { PlanInputDevice } from '../packages/planner-types/src/planInputDevice';

const HOUR_MS = 60 * 60 * 1000;
const DAY_START_MS = Date.UTC(2026, 0, 1, 0);
// Current hour = 12; deadline = 18. The horizon window is hours 12..17 (six
// hours). A mid-hour `nowMs` clips the current bucket exactly as the live cycle
// sees it.
const CURRENT_HOUR = 12;
const DEADLINE_HOUR = 18;
const NOW_MS = DAY_START_MS + CURRENT_HOUR * HOUR_MS + 30 * 60 * 1000;
const DEADLINE_MS = DAY_START_MS + DEADLINE_HOUR * HOUR_MS;
const DEVICE_ID = 'water-heater';
const STEP: DeferredObjectiveStep = { id: 'low', usefulPowerKw: 1 };

// Build a real DailyBudgetUiPayload carrying `horizonPrices` on hours 12..17.
// Non-horizon hours get a flat filler price — they are filtered out before the
// horizon is built, so they cannot influence the result.
const snapshotFor = (horizonPrices: readonly number[]): DailyBudgetUiPayload => {
  const startUtc = Array.from({ length: 24 }, (_, h) => new Date(DAY_START_MS + h * HOUR_MS).toISOString());
  const price = Array.from({ length: 24 }, (_, h) => {
    const offset = h - CURRENT_HOUR;
    return offset >= 0 && offset < horizonPrices.length ? horizonPrices[offset]! : 70;
  });
  const day: DailyBudgetDayPayload = {
    dateKey: '2026-01-01',
    timeZone: 'UTC',
    nowUtc: new Date(NOW_MS).toISOString(),
    dayStartUtc: new Date(DAY_START_MS).toISOString(),
    currentBucketIndex: CURRENT_HOUR,
    budget: { enabled: true, dailyBudgetKWh: 20, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: 0,
      remainingKWh: 20,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: true,
    },
    buckets: {
      startUtc,
      startLocalLabels: startUtc.map((_, h) => `${String(h).padStart(2, '0')}:00`),
      plannedWeight: Array.from({ length: 24 }, () => 1 / 24),
      plannedKWh: Array.from({ length: 24 }, () => 1),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      plannedControlledKWh: Array.from({ length: 24 }, () => 0),
      actualKWh: Array.from({ length: 24 }, () => 0),
      actualControlledKWh: Array.from({ length: 24 }, () => null),
      actualUncontrolledKWh: Array.from({ length: 24 }, () => null),
      allowedCumKWh: Array.from({ length: 24 }, (_, h) => h + 1),
      price,
      // No priceFactor: the allocator orders purely on the raw `price` series —
      // the RELATIVE within-horizon comparison under test.
    },
  };
  return { days: { '2026-01-01': day }, todayKey: '2026-01-01', tomorrowKey: null };
};

const objective = (energyNeededKWh: number): DeferredObjective => ({
  id: `${DEVICE_ID}:temperature`,
  kind: 'temperature',
  enforcement: 'soft',
  energyNeededKWh,
  deadlineAtMs: DEADLINE_MS,
});

const diagnosticFor = (plan: DeferredObjectiveHorizonPlan, energyNeededKWh: number): DeferredObjectiveDiagnostic => ({
  deviceId: DEVICE_ID,
  deviceName: 'Connected 300',
  objectiveId: `${DEVICE_ID}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  status: plan.status,
  reasonCode: plan.statusDetail,
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 65,
  currentTemperatureC: 50,
  deadlineAtMs: DEADLINE_MS,
  deadlineLocalTime: '18:00',
  energyNeededKWh,
  kWhPerPercent: null,
  kWhPerDegreeC: 1.5,
  rateConfidence: 'high',
  kwhPerUnitSource: 'learned',
  horizonBucketCount: plan.plannedBuckets.length,
  dailyBudgetExhaustedBucketCount: 0,
  expectedStepId: plan.expectedStepId,
  horizonPlan: plan,
});

const device: PlanInputDevice = { id: DEVICE_ID, controllable: false } as PlanInputDevice;

type BuildTimeResult = {
  // Booked energy summed by the price the hour carries.
  bookedByPrice: Map<number, number>;
  currentHourBookedKWh: number;
  decisionKind: 'planned' | 'idle' | 'inactive';
  status: DeferredObjectiveHorizonPlan['status'];
  statusDetail: DeferredObjectiveHorizonPlan['statusDetail'];
};

const runBuildTime = (horizonPrices: readonly number[], energyNeededKWh: number): BuildTimeResult => {
  const horizon = buildDeferredObjectivePolicyHorizon({
    nowMs: NOW_MS,
    deadlineAtMs: DEADLINE_MS,
    priceOptimizationEnabled: true,
    dailyBudgetSnapshot: snapshotFor(horizonPrices),
    exemptFromBudget: true, // lift the daily-budget cap so PRICE is the only allocation lever
  });
  expect(horizon.reasonCode).toBeNull(); // the producer accepted the price horizon

  const plan = planDeferredObjectiveHorizon({
    nowMs: NOW_MS,
    objective: objective(energyNeededKWh),
    steps: [STEP],
    buckets: horizon.buckets,
    committed: false, // fresh build-time allocation (no prior commitment)
  });

  const bookedByPrice = new Map<number, number>();
  let currentHourBookedKWh = 0;
  for (const bucket of plan.plannedBuckets) {
    if (typeof bucket.price === 'number') {
      bookedByPrice.set(bucket.price, (bookedByPrice.get(bucket.price) ?? 0) + bucket.plannedUsefulEnergyKWh);
    }
    if (bucket.current) currentHourBookedKWh += bucket.plannedUsefulEnergyKWh;
  }

  const decision = applyDeferredObjectiveAdmission([diagnosticFor(plan, energyNeededKWh)], [device]).get(DEVICE_ID)!;
  return {
    bookedByPrice,
    currentHourBookedKWh,
    decisionKind: decision.kind as BuildTimeResult['decisionKind'],
    status: plan.status,
    statusDetail: plan.statusDetail,
  };
};

// Book a fixed need into a one-hour horizon at a single price, returning the
// energy the planner commits to that hour. Isolates "does price change the
// per-hour power ceiling?" — the deadline is one hour out so only the current
// hour exists (no cheaper hour to prefer or defer to).
const runBuildTimeSingleHour = (price: number): number => {
  const horizon = buildDeferredObjectivePolicyHorizon({
    nowMs: DAY_START_MS + CURRENT_HOUR * HOUR_MS, // hour start: full, unclipped current hour
    deadlineAtMs: DAY_START_MS + (CURRENT_HOUR + 1) * HOUR_MS,
    priceOptimizationEnabled: true,
    dailyBudgetSnapshot: snapshotFor([price]),
    exemptFromBudget: true,
  });
  expect(horizon.reasonCode).toBeNull();
  const plan = planDeferredObjectiveHorizon({
    nowMs: DAY_START_MS + CURRENT_HOUR * HOUR_MS,
    objective: objective(0.8), // < 1 kWh step capacity, so the cap is not the binding limit
    steps: [STEP],
    buckets: horizon.buckets,
    committed: false,
  });
  return plan.plannedBuckets.reduce((sum, b) => sum + b.plannedUsefulEnergyKWh, 0);
};

describe('smart-task build-time price ordering — e2e (cheap hours filled first)', () => {
  it('books the CHEAP hours and leaves the expensive (current) hour empty', () => {
    // Hours 12,13 expensive (100); hours 14..17 cheap (50). A 2 kWh need fits
    // entirely in the cheap hours.
    const result = runBuildTime([100, 100, 50, 50, 50, 50], 2);

    expect(result.status).toBe('on_track');
    expect(result.bookedByPrice.get(50) ?? 0).toBeCloseTo(2, 3); // all energy in the cheap hours
    expect(result.bookedByPrice.get(100) ?? 0).toBeCloseTo(0, 3); // nothing in the expensive hours
    expect(result.currentHourBookedKWh).toBeCloseTo(0, 3); //         expensive current hour unbooked
    expect(result.decisionKind).toBe('idle'); //                      → device held off in the expensive hour
  });

  it('RUNS in the current hour when it is the cheap one — only the curve flipped', () => {
    // Same need, same everything; the curve is flipped so the current hours are
    // cheap and the later hours dear. The energy now lands on the current hours
    // and the device runs.
    const result = runBuildTime([50, 50, 100, 100, 100, 100], 2);

    expect(result.bookedByPrice.get(50) ?? 0).toBeGreaterThan(result.bookedByPrice.get(100) ?? 0);
    expect(result.currentHourBookedKWh).toBeGreaterThan(0); // cheap current hour carries load
    expect(result.decisionKind).toBe('planned'); //           → device runs
  });

  it('is RELATIVE, not an absolute band: scaling every price keeps the cheap-first split', () => {
    // ×10 and ÷100 of the same curve must produce the same "all energy in the
    // cheaper hours, expensive current hour idle" outcome — only the ratio matters.
    for (const [dear, cheap] of [[1000, 500], [1, 0.5]] as const) {
      const result = runBuildTime([dear, dear, cheap, cheap, cheap, cheap], 2);
      expect(result.bookedByPrice.get(cheap) ?? 0).toBeCloseTo(2, 3);
      expect(result.bookedByPrice.get(dear) ?? 0).toBeCloseTo(0, 3);
      expect(result.decisionKind).toBe('idle');
    }
  });

  it('keeps the earlier hour when a later one is only marginally cheaper (within the price band)', () => {
    // The current hour (102) is ~2% DEARER than the later hours (100). That is
    // inside the relative band, so the hours tie on price and the time tiebreak
    // keeps the EARLIER (current) slot — the device runs now rather than stranding
    // the current hour to chase a sub-margin saving. A small need fits in the
    // clipped half-hour current bucket alone.
    const result = runBuildTime([102, 100, 100, 100, 100, 100], 0.3);

    expect(result.currentHourBookedKWh).toBeGreaterThan(0);
    expect(result.decisionKind).toBe('planned');
  });

  it('defers the earlier hour when a later one is MEANINGFULLY cheaper (beyond the band)', () => {
    // Now the later hours (90) are ~10% cheaper than the current hour (100) —
    // clear of the band — so the load shifts to them and the current hour idles.
    const result = runBuildTime([100, 90, 90, 90, 90, 90], 0.3);

    expect(result.currentHourBookedKWh).toBeCloseTo(0, 3);
    expect(result.decisionKind).toBe('idle');
  });

  it('makes the SAME tie/defer decision regardless of price units (currency-invariant)', () => {
    // The build-time band is anchored to the set's min price, so it depends only
    // on price RATIOS. The 2%-spread tie and the 10%-spread defer must hold
    // whether the feed is in øre (×1) or €/kWh (÷100) — the unit must not flip
    // the schedule for an identical curve.
    for (const scale of [1, 0.01] as const) {
      const tie = runBuildTime([102, 100, 100, 100, 100, 100].map((p) => p * scale), 0.3);
      expect(tie.decisionKind).toBe('planned');
      const defer = runBuildTime([100, 90, 90, 90, 90, 90].map((p) => p * scale), 0.3);
      expect(defer.decisionKind).toBe('idle');
    }
  });

  it('spills into the dearer hours only when the cheap hours cannot hold the whole need — still on_track', () => {
    // 4 cheap hours × 1 kW = 4 kWh capacity. A 5 kWh need overflows them, so the
    // allocator must use some expensive capacity too — but still fills the cheap
    // hours first. Running in a relatively pricier hour is NOT a risk signal, so
    // the plan stays on_track (the need still fits before the deadline).
    const result = runBuildTime([100, 100, 50, 50, 50, 50], 5);

    const cheap = result.bookedByPrice.get(50) ?? 0;
    const dear = result.bookedByPrice.get(100) ?? 0;
    expect(cheap).toBeGreaterThan(dear); // cheap hours preferred and filled first
    expect(cheap).toBeCloseTo(4, 3); //    all four cheap hours fully used
    expect(cheap + dear).toBeGreaterThan(4); // the overflow genuinely reached the dear hours
    expect(result.status).toBe('on_track'); // price tier never flips status
    expect(result.statusDetail).toBe('planned_with_margin');
  });
});

describe('smart-task per-hour power cap is price-blind', () => {
  it('an expensive hour the plan DOES use is filled to the same per-hour capacity as a cheap one', () => {
    // The smart-task per-hour ceiling is min(step capacity, daily-budget slice,
    // reservedHeadroomKw) — see resolveBucketStepCapacityKWh. No price term. So an
    // expensive hour that the plan uses is filled to exactly the same per-hour
    // capacity as a cheap hour; price never throttles the magnitude.
    //
    // Proof by symmetry: book a fixed need into a single dear hour vs a single
    // cheap hour (deadline one hour out, so there is only the current hour). The
    // booked energy is identical — the price does not cap it.
    const dearOnly = runBuildTimeSingleHour(100);
    const cheapOnly = runBuildTimeSingleHour(5);
    expect(dearOnly).toBeCloseTo(cheapOnly, 6); // expensive hour is NOT power-capped relative to cheap
    expect(dearOnly).toBeGreaterThan(0);
  });
});
