// End-to-end proof that smart-task (deferred-objective) price deferral actively
// prefers cheaper hours over more expensive ones, using a RELATIVE price
// comparison (raw-price ratio, not an absolute band).
//
// It drives the REAL decision pipeline, nothing mocked in the middle:
//
//   physics (measured progress)                    price curve + committed plan
//            │                                                 │
//            ▼                                                 ▼
//   isAheadOfHourMilestone()  ──►  planDeferredObjectiveHorizon()  ──►  diagnostic
//   (trajectory producer)         (combines the trajectory gate with the
//                                  relative raw-price test → priceDeferralEligible)
//                                                  │
//                                                  ▼
//                                  applyDeferredObjectiveAdmission()
//                                  (the consumer that idles / runs the device)
//
// The assertion target is the FINAL device decision: `kind: 'planned'` ⇒ the
// device runs this hour; `kind: 'idle'` ⇒ the device is held off (deferred) so a
// cheaper hour carries the load. Everything is held equal across scenarios except
// the relative price of the hours, so any change in the decision is attributable
// to price alone.
//
// See notes/deferred-load-objectives/execution-adaptation.md (work item 2).
import { planDeferredObjectiveHorizon } from '../lib/objectives/deferredObjectives';
import { applyDeferredObjectiveAdmission } from '../lib/objectives/deferredObjectives/admission';
import { isAheadOfHourMilestone } from '../lib/objectives/deferredObjectives/trajectoryMilestone';
import type { DeferredObjectiveDiagnostic } from '../lib/objectives/deferredObjectives/diagnosticsBridge';
import type {
  DeferredObjective,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveStep,
} from '../lib/objectives/deferredObjectives';
import type { DeferredObjectiveActivePlanHourV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { PlanInputDevice } from '../packages/planner-types/src/planInputDevice';

const HOUR_MS = 60 * 60 * 1000;
// Midnight UTC so absolute-ms hour edges line up with `hourIndex * HOUR_MS`.
const BASE_MS = Date.UTC(2026, 0, 1, 0);
// Cycles tick mid-hour: the current bucket is clipped to `nowMs` but stays the
// current hour, exactly as the live power cycle sees it.
const MID_HOUR_OFFSET_MS = 30 * 60 * 1000;
const DEVICE_ID = 'water-heater';
// A single low element. Concrete kW is irrelevant to the price test — the
// committed plan supplies the per-hour booked energy (the floor the live
// deferral overrides).
const STEP: DeferredObjectiveStep = { id: 'low', usefulPowerKw: 1 };

const objective = (deadlineHourIndex: number, energyNeededKWh: number): DeferredObjective => ({
  id: `${DEVICE_ID}:temperature`,
  kind: 'temperature',
  enforcement: 'soft',
  energyNeededKWh,
  deadlineAtMs: BASE_MS + deadlineHourIndex * HOUR_MS,
});

// One horizon bucket per remaining clock hour, each carrying its raw price. The
// planner trims the current bucket's start to `nowMs` and tags current/reserve
// internally.
const buildPriceBuckets = (
  nowMs: number,
  deadlineHourIndex: number,
  prices: readonly number[],
): DeferredObjectiveHorizonBucket[] => {
  const buckets: DeferredObjectiveHorizonBucket[] = [];
  const firstHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  for (let startMs = firstHour; startMs < BASE_MS + deadlineHourIndex * HOUR_MS; startMs += HOUR_MS) {
    const hourIndex = Math.round((startMs - BASE_MS) / HOUR_MS);
    buckets.push({
      id: `h${hourIndex}`,
      startMs: Math.max(startMs, nowMs),
      endMs: startMs + HOUR_MS,
      price: prices[hourIndex] ?? null,
    });
  }
  return buckets;
};

// The committed plan a prior :58 settle produced: the floor that stays booked as
// a fallback and that the live deferral overrides. Feeds BOTH the trajectory gate
// and the planner's committed-replan path (same `{ startsAtMs, plannedKWh }`
// shape), so the test never hand-sets the ahead flag.
const buildCommittedHours = (
  committedKWhByHour: Readonly<Record<number, number>>,
): DeferredObjectiveActivePlanHourV1[] => (
  Object.entries(committedKWhByHour).map(([hourIndex, plannedKWh]) => ({
    startsAtMs: BASE_MS + Number(hourIndex) * HOUR_MS,
    plannedKWh,
  }))
);

const diagnosticFor = (
  plan: DeferredObjectiveHorizonPlan,
  deadlineHourIndex: number,
  energyNeededKWh: number,
): DeferredObjectiveDiagnostic => ({
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
  currentTemperatureC: 60,
  deadlineAtMs: BASE_MS + deadlineHourIndex * HOUR_MS,
  deadlineLocalTime: '06:00',
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

// A cap-off water heater (controllable=false): the only reason PELS drives it is
// the smart task, so a released hour idles it (`kind: 'idle'`).
const device: PlanInputDevice = { id: DEVICE_ID, controllable: false } as PlanInputDevice;

type CycleResult = {
  ahead: boolean;
  priceDeferralEligible: boolean;
  decisionKind: 'planned' | 'idle' | 'inactive';
  runs: boolean;
};

// Drive ONE power cycle through the full real pipeline and report the device's
// run/defer decision.
const runCycle = (params: {
  currentHourIndex: number;
  deadlineHourIndex: number;
  energyNeededKWh: number;
  prices: readonly number[];
  committedKWhByHour: Readonly<Record<number, number>>;
}): CycleResult => {
  const nowMs = BASE_MS + params.currentHourIndex * HOUR_MS + MID_HOUR_OFFSET_MS;
  const committedHours = buildCommittedHours(params.committedKWhByHour);

  // Producer trajectory gate — computed from measured need vs the committed
  // future, exactly as `diagnosticsBridge` does in production.
  const ahead = isAheadOfHourMilestone({
    energyNeededKWh: params.energyNeededKWh,
    committedHours,
    nowMs,
  });

  const plan = planDeferredObjectiveHorizon({
    nowMs,
    objective: objective(params.deadlineHourIndex, params.energyNeededKWh),
    steps: [STEP],
    buckets: buildPriceBuckets(nowMs, params.deadlineHourIndex, params.prices),
    committed: true,
    committedHours,
    aheadOfHourMilestone: ahead,
  });

  const diagnostic = diagnosticFor(plan, params.deadlineHourIndex, params.energyNeededKWh);
  const decision = applyDeferredObjectiveAdmission([diagnostic], [device]).get(DEVICE_ID)!;

  return {
    ahead,
    priceDeferralEligible: plan.priceDeferralEligible,
    decisionKind: decision.kind as CycleResult['decisionKind'],
    runs: decision.kind === 'planned',
  };
};

// An objective whose committed plan books 1 kWh in every hour of a 6-hour
// horizon (the 1 kW element, one hour each). The device is comfortably ahead of
// its trajectory: only 1.4 kWh of buffered need remains, and the future
// committed hours cover it several times over. Held constant across the price
// scenarios below — only the price curve changes.
//
// Why 1.4 kWh and not a token amount: the allocator preserves the committed plan
// by filling its hours EARLIEST-first up to the live need. The live deferral only
// releases toward a later hour the plan actually books load into (releasing
// toward an unbooked hour would just push the load into the next booked hour, not
// the cheap one). 1.4 kWh books the current clipped half-hour (0.5 kWh) plus 0.9
// kWh of the NEXT hour — so the next hour is the booked candidate whose price the
// release test weighs against the current hour. The curves below therefore put
// the price contrast on that SECOND hour.
const AHEAD_COMMITMENT: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };
const baseCycle = (prices: readonly number[], currentHourIndex = 0): CycleResult => runCycle({
  currentHourIndex,
  deadlineHourIndex: 6,
  energyNeededKWh: 1.4,
  prices,
  committedKWhByHour: AHEAD_COMMITMENT,
});

describe('smart-task price deferral — e2e (cheap hours actively preferred)', () => {
  it('sanity-checks the harness: the device is genuinely ahead of its milestone', () => {
    // Precondition for every scenario below — the trajectory gate is satisfied,
    // so the ONLY remaining lever on the decision is relative price.
    expect(baseCycle([100, 50, 50, 50, 50, 50]).ahead).toBe(true);
  });

  it('DEFERS an expensive current hour when the next booked hour is cheaper', () => {
    // Now = expensive hour 0 (100 øre); the next booked hour is cheaper (50 øre).
    const result = baseCycle([100, 50, 50, 50, 50, 50]);

    expect(result.ahead).toBe(true); // trajectory gate held constant vs the run case below
    expect(result.priceDeferralEligible).toBe(true);
    expect(result.decisionKind).toBe('idle'); // held off — a cheaper hour carries the load
    expect(result.runs).toBe(false);
  });

  it('RUNS in a cheap current hour when the next hour is not cheaper — only the curve changed', () => {
    // Identical commitment, identical ahead-ness; ONLY the price curve is flipped
    // so the current hour is the cheap one and the next is dear. The device runs.
    const result = baseCycle([50, 100, 100, 100, 100, 100]);

    expect(result.ahead).toBe(true); // SAME gate as the defer case — only price moved
    expect(result.priceDeferralEligible).toBe(false);
    expect(result.decisionKind).toBe('planned'); // runs — this IS the cheap hour
    expect(result.runs).toBe(true);
  });

  it('uses a RELATIVE comparison: scaling every price 10× (or tiny) keeps the same decision', () => {
    // If the test were an absolute price band, multiplying all prices by 10 (or
    // shrinking them) would change the outcome. It does not — only the ratio
    // between hours matters.
    expect(baseCycle([1000, 500, 500, 500, 500, 500]).runs).toBe(false); // still defers the (huge) expensive hour
    expect(baseCycle([1, 0.5, 0.5, 0.5, 0.5, 0.5]).runs).toBe(false); //   still defers the (tiny) expensive hour
    // And the flipped curve still runs at every scale.
    expect(baseCycle([500, 1000, 1000, 1000, 1000, 1000]).runs).toBe(true);
    expect(baseCycle([0.5, 1, 1, 1, 1, 1]).runs).toBe(true);
  });

  it('requires a MEANINGFUL gap: a sub-5%-margin saving does not trigger deferral', () => {
    // Next hour only ~3% cheaper (97 vs 100) — below the 5% relative margin, so
    // the device keeps the safer earlier slot and runs now.
    expect(baseCycle([100, 97, 97, 97, 97, 97]).runs).toBe(true);
    // Next hour ~6% cheaper (94 vs 100) — clears the margin, so it defers.
    expect(baseCycle([100, 94, 94, 94, 94, 94]).runs).toBe(false);
  });

  it('treats free/negative prices by sign: defers toward a paid (negative) hour, runs when now is free', () => {
    // A later NEGATIVE price (you are paid to consume) is unambiguously cheaper —
    // defer the load into it.
    expect(baseCycle([100, -5, 50, 50, 50, 50]).runs).toBe(false);
    // When the CURRENT hour is free (0) there is nothing to save by waiting — just
    // run now rather than deferring on a meaningless ratio.
    expect(baseCycle([0, 50, 50, 50, 50, 50]).runs).toBe(true);
  });

  it('walks a window with one expensive hour and shifts the load past it', () => {
    // The headline behaviour: as the clock advances hour by hour, the device —
    // staying ahead of its milestone the whole way — holds off during the single
    // expensive hour and then runs through the cheap window, actively shifting
    // its load away from the expensive hour.
    const prices = [100, 50, 50, 50, 50, 50];
    const decisions = [0, 1, 2, 3].map((hour) => baseCycle(prices, hour).runs);

    expect(decisions).toEqual([
      false, // hour 0 (100 øre) — deferred: the next booked hour is cheaper
      true, //  hour 1 ( 50 øre) — runs in the cheap window
      true, //  hour 2 ( 50 øre) — runs in the cheap window
      true, //  hour 3 ( 50 øre) — runs in the cheap window
    ]);
  });
});
