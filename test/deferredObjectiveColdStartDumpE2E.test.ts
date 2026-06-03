// REPRODUCTION of the production catastrophe (Connected 300 water heater, night
// of 2026-05-31): a cold tank at the start of an expensive window dumped its
// whole catch-up into the most expensive hour, then the cheap window sat unused.
//
// Root cause (from /tmp/pels/window_since_8pm.stdout.log): the cold tank made
// `energyNeededKWh` ~19–29 kWh while each bucket was sized at the COMMITTED step
// (`low` 1.25 kW / `medium` 1.67 kW). That looked infeasible → `cannot_meet` →
// the allocator books every hour cheapest-first INCLUDING the `avoid` ones, and
// admission drives the device (for a cap-off temperature device, "drive" = set
// target high = the real ~5 kW element runs, which PELS cannot throttle). So the
// catch-up burned in the 86-øre hour even though the device is fast enough to
// finish entirely inside the 73-øre window.
//
// This test drives the REAL planner + admission hour-by-hour against a bang-bang
// thermal model whose real element (5 kW) far exceeds the booked `low` step
// (1.25 kW). It asserts the DESIRED behavior — the expensive hours carry ~no load
// — so it is RED on today's code (which dumps into the expensive hour) and GREEN
// once feasibility is sized against the device's real throughput.
import { planDeferredObjectiveHorizon } from '../lib/objectives/deferredObjectives';
import { applyDeferredObjectiveAdmission } from '../lib/objectives/deferredObjectives/admission';
import type { DeferredObjectiveDiagnostic } from '../lib/objectives/deferredObjectives/diagnosticsBridge';
import type {
  DeferredObjective,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveStep,
} from '../lib/objectives/deferredObjectives';
import type { PlanInputDevice } from '../packages/planner-types/src/planInputDevice';

const HOUR_MS = 60 * 60 * 1000;
const DAY = Date.UTC(2026, 0, 1, 0);
const START_HOUR = 18; // 18:00 local-ish; first expensive hour, cold start
const DEADLINE_HOUR = 30; // 06:00 next day → a 12-hour window
const DEVICE_ID = 'water-heater';

// Prices: the two 86.1-øre "day" hours (18:00, 19:00), then 73.0-øre "night".
const EXPENSIVE = 86.1;
const CHEAP = 73.0;
const priceForHour = (hour: number): number => (hour < 20 ? EXPENSIVE : CHEAP);

// Device thermal reality.
const TARGET_C = 63;
const START_C = 35; // ~28 °C of cold-start catch-up
const RATE_KWH_PER_C = 0.68; // 28 °C ⇒ ~19 kWh, matching the prod `energyNeededKWh`
const REAL_ELEMENT_KW = 5; // what the element ACTUALLY draws when the target is raised
const STANDBY_LOSS_C_PER_H = 0.3; // tank cools while held

// Booked steps: the commitment is sized at `low` (1.25 kW), but the device CAN
// climb to its real element. `max` represents the physical element.
const STEPS: DeferredObjectiveStep[] = [
  { id: 'off', usefulPowerKw: 0 },
  { id: 'low', usefulPowerKw: 1.25 },
  { id: 'max', usefulPowerKw: REAL_ELEMENT_KW },
];

const bucketsFrom = (nowMs: number): DeferredObjectiveHorizonBucket[] => {
  const buckets: DeferredObjectiveHorizonBucket[] = [];
  for (let h = Math.floor(nowMs / HOUR_MS) * HOUR_MS; h < DAY + DEADLINE_HOUR * HOUR_MS; h += HOUR_MS) {
    const hourOfDay = Math.round((h - DAY) / HOUR_MS);
    buckets.push({
      id: `h${hourOfDay}`,
      startMs: Math.max(h, nowMs),
      endMs: h + HOUR_MS,
      // New model: price is the SOLE signal — the allocator fills cheapest-first
      // by relative price; there is no preference/policyScore band any more.
      price: priceForHour(hourOfDay),
    });
  }
  return buckets;
};

const objective = (energyNeededKWh: number): DeferredObjective => ({
  id: `${DEVICE_ID}:temperature`,
  kind: 'temperature',
  enforcement: 'soft',
  energyNeededKWh,
  deadlineAtMs: DAY + DEADLINE_HOUR * HOUR_MS,
});

const diagnosticFor = (
  plan: DeferredObjectiveHorizonPlan,
  energyNeededKWh: number,
  currentTemperatureC: number,
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
  targetTemperatureC: TARGET_C,
  currentTemperatureC,
  deadlineAtMs: DAY + DEADLINE_HOUR * HOUR_MS,
  deadlineLocalTime: '06:00',
  energyNeededKWh,
  kWhPerPercent: null,
  kWhPerDegreeC: RATE_KWH_PER_C,
  rateConfidence: 'high',
  kwhPerUnitSource: 'learned',
  horizonBucketCount: plan.plannedBuckets.length,
  dailyBudgetExhaustedBucketCount: 0,
  expectedStepId: plan.expectedStepId,
  horizonPlan: plan,
});

const device: PlanInputDevice = { id: DEVICE_ID, controllable: false } as PlanInputDevice;

type HourOutcome = {
  hourOfDay: number;
  price: number;
  tempStartC: number;
  status: DeferredObjectiveHorizonPlan['status'];
  driven: boolean; // admission decided to run the device this hour
  consumedKWh: number; // real element energy delivered this hour
};

// Drive the cold-start scenario hour-by-hour through the real planner + admission
// against a bang-bang thermal model.
const runScenario = (): { outcomes: HourOutcome[]; finalTempC: number } => {
  const outcomes: HourOutcome[] = [];
  let tempC = START_C;
  for (let hourOfDay = START_HOUR; hourOfDay < DEADLINE_HOUR; hourOfDay += 1) {
    // Tick at the hour boundary so the planner's current bucket is a FULL hour —
    // matching the bang-bang model's full-hour delivery (no sub-hour clip skew).
    const nowMs = DAY + hourOfDay * HOUR_MS;
    const remainingC = Math.max(0, TARGET_C - tempC);
    const energyNeededKWh = remainingC * RATE_KWH_PER_C;

    const plan = planDeferredObjectiveHorizon({
      nowMs,
      objective: objective(energyNeededKWh),
      steps: STEPS,
      buckets: bucketsFrom(nowMs),
      committed: false,
    });
    const decision = applyDeferredObjectiveAdmission(
      [diagnosticFor(plan, energyNeededKWh, tempC)],
      [device],
    ).get(DEVICE_ID)!;
    const driven = decision.kind === 'planned';

    const tempStartC = tempC;
    let consumedKWh = 0;
    if (driven && remainingC > 0) {
      // Bang-bang: the real element runs full power for the hour (or until target).
      const deliverableKWh = Math.min(REAL_ELEMENT_KW, remainingC * RATE_KWH_PER_C);
      consumedKWh = deliverableKWh;
      tempC += deliverableKWh / RATE_KWH_PER_C;
    } else {
      tempC = Math.max(START_C - 5, tempC - STANDBY_LOSS_C_PER_H); // standby cooling while held
    }

    outcomes.push({ hourOfDay, price: priceForHour(hourOfDay), tempStartC, status: plan.status, driven, consumedKWh });
  }
  return { outcomes, finalTempC: tempC };
};

describe('cold-start expensive-hour dump (reproduction + regression guard)', () => {
  const { outcomes, finalTempC } = runScenario();
  const consumedAt = (price: number): number => outcomes
    .filter((o) => o.price === price)
    .reduce((sum, o) => sum + o.consumedKWh, 0);

  it('reaches the target by the deadline (the task still succeeds)', () => {
    // Assert on the ACTUAL simulated temperature (which includes the standby
    // cooling applied during held hours), not an energy-derived estimate.
    expect(finalTempC).toBeGreaterThanOrEqual(TARGET_C - 1);
  });

  it('does NOT burn the cold-start catch-up in the expensive hours', () => {
    // DESIRED: the 86.1-øre hours carry ~no load — the fast device defers its
    // catch-up into the 73-øre window it can comfortably finish in.
    // TODAY: false cannot_meet drives the device at 18:00 → this FAILS.
    expect(consumedAt(EXPENSIVE)).toBeLessThanOrEqual(0.5);
  });

  it('delivers essentially all of the energy in the cheap window', () => {
    expect(consumedAt(CHEAP)).toBeGreaterThan(consumedAt(EXPENSIVE) * 10);
  });
});
