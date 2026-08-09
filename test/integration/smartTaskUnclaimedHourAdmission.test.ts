// Integration-tier proof that a task which no longer needs an hour keeps only its
// CHEAPEST allocated hours in play — the price half of what an unbooked hour means.
//
// Integration rather than e2e per `notes/testing-taxonomy.md` § "The border cases":
// it spans the planner and admission layers with nothing internal mocked, but it
// drives them by calling `planDeferredObjectiveHorizon` /
// `applyDeferredObjectiveAdmission` and asserts on the returned decision, so it is
// integration, not SDK-in/logs-out. The SDK-boundary companion that drives the real
// bridge + recorder + frozen dispatch is
// `test/e2e/smartTaskUnclaimedHourSdkE2E.test.ts`; this spec exists alongside it
// because it can name the expected hours EXACTLY, which an aggregate energy
// comparison through the full stack cannot.
//
// An hour books 0 for two unrelated reasons. Either the fill already met the need
// and the hour is genuinely surplus — the price decision, "don't use an hour we
// don't have to" — or the soft daily budget's forecast controlled share for that
// hour was 0, so the allocator had no room to promise anything
// (`policyHorizon.resolveMaxUsefulEnergyKWh`). Admission used to treat both the
// same and stand the device down, which stops a task that is behind for no reason
// the physical world imposed.
//
// It drives the REAL pipeline, nothing mocked in the middle:
//
//   per-bucket budget share + price curve
//                 │
//                 ▼
//   planDeferredObjectiveHorizon()  ──►  plan (booked hours + canSkipUnbookedHours)
//                 │
//                 ▼
//   applyDeferredObjectiveAdmission()  ──►  planned / unclaimed / idle
//                 │
//                 ▼
//   applyDeferredAdmissionToInput()    ──►  what the planner actually receives
//
// The two scenarios differ ONLY in `energyNeededKWh`. Same prices, same per-hour
// budget shares, same device — so any difference in the device's treatment is
// attributable to whether the task can finish without the hour.
//
// `aheadOfHourMilestone` comes from the REAL producer, never pinned
// (`lib/objectives/deferredObjectives/AGENTS.md`). These scenarios re-plan afresh
// each hour, so there is no prior commitment for it to read and it resolves false
// on its own — which is what leaves the sufficiency gate as the only thing that can
// release the device, and makes each release below attributable to it.
import { describe, expect, it } from 'vitest';
import { planDeferredObjectiveHorizon } from '../../lib/objectives/deferredObjectives';
import {
  applyDeferredAdmissionToInput,
  applyDeferredObjectiveAdmission,
} from '../../lib/objectives/deferredObjectives/admission';
import { isAheadOfHourMilestone } from '../../lib/objectives/deferredObjectives/trajectoryMilestone';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import type {
  DeferredObjective,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveStep,
} from '../../lib/objectives/deferredObjectives';
import type { PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';

const HOUR_MS = 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 0, 1, 0);
const DEVICE_ID = 'water-heater';
const DEADLINE_HOUR = 8;
// One 1 kW element, so an hour of runway is worth exactly 1 kWh and the arithmetic
// below is readable by eye.
const STEP: DeferredObjectiveStep = { id: 'low', usefulPowerKw: 1 };

// Spread well beyond `PRICE_BAND_MARGIN` (~5%), so the fill order is a strict
// cheapest-first and no two hours tie into the time tiebreak. Cheapest are h2 (30)
// and h6 (35); everything else is at least twice that.
const PRICES = [90, 80, 30, 70, 95, 85, 35, 100] as const;
const CHEAPEST_HOURS = [2, 6] as const;

// The soft daily budget's controlled share for the hour. `0` is the case under
// test: the budget layer forecast no room for managed load that hour, so the
// allocator can book nothing there no matter how badly the task needs it. The
// remaining hours are left uncapped so step capacity is their only ceiling.
const ZERO_SHARE_HOURS = new Set([1, 5]);

const objective = (energyNeededKWh: number): DeferredObjective => ({
  id: `${DEVICE_ID}:temperature`,
  kind: 'temperature',
  enforcement: 'soft',
  energyNeededKWh,
  deadlineAtMs: BASE_MS + DEADLINE_HOUR * HOUR_MS,
  // No deadline reserve: every bucket is then a whole hour, so a booked hour and a
  // clock hour are the same thing and the sweep below reads one hour per step.
  deadlineMarginMs: 0,
});

const buildBuckets = (nowMs: number): DeferredObjectiveHorizonBucket[] => {
  const buckets: DeferredObjectiveHorizonBucket[] = [];
  for (let hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    hour < BASE_MS + DEADLINE_HOUR * HOUR_MS;
    hour += HOUR_MS) {
    const hourIndex = Math.round((hour - BASE_MS) / HOUR_MS);
    buckets.push({
      id: `h${hourIndex}`,
      startMs: Math.max(hour, nowMs),
      endMs: hour + HOUR_MS,
      price: PRICES[hourIndex] ?? null,
      ...(ZERO_SHARE_HOURS.has(hourIndex) ? { maxUsefulEnergyKWh: 0 } : {}),
    });
  }
  return buckets;
};

const diagnosticFor = (
  plan: DeferredObjectiveHorizonPlan,
  energyNeededKWh: number,
): DeferredObjectiveDiagnostic => ({
  deviceId: DEVICE_ID,
  deviceName: 'Connected 300',
  objectiveId: `${DEVICE_ID}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  trajectory: { kind: 'resolved', status: plan.status },
  reasonCode: plan.statusDetail,
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 65,
  currentTemperatureC: 60,
  currentValue: 60,
  targetValue: 65,
  deadlineAtMs: BASE_MS + DEADLINE_HOUR * HOUR_MS,
  deadlineLocalTime: '08:00',
  energyNeededKWh,
  kWhPerUnitBanded: 1.5,
  kwhPerUnitLearnedMean: 1.5,
  rateConfidence: 'high',
  displayConfidence: 'high',
  kwhPerUnitSource: 'learned',
  kwhPerUnitAcceptedSamples: 0,
  kwhPerUnitLastAcceptedAtMs: null,
  planningSpeedKw: null,
  horizonBucketCount: plan.plannedBuckets.length,
  expectedStepId: plan.expectedStepId,
  horizonPlan: plan,
});

// A cap-off water heater: the smart task is the only reason PELS drives it, so
// every difference between claimed / unclaimed / released is visible in what the
// planner is handed.
const device: PlanInputDevice = { id: DEVICE_ID, controllable: false } as PlanInputDevice;

type HourOutcome = {
  hourIndex: number;
  price: number;
  kind: string;
  bookedKWh: number;
  // What the planner receives for the hour. `forceShed` is the stand-down; an
  // unclaimed hour hands over a managed device and nothing else.
  managed: boolean;
  forceShed: boolean;
  releaseIntent: string | undefined;
  deliveredKWh: number;
};

// Walk the task hour by hour, delivering whatever the decision permits and
// carrying the remaining need forward — so the horizon really does shrink as the
// device makes progress, and a task that finishes early stops on its own.
//
// Each hour is evaluated at its START. Mid-hour the current bucket is clipped and
// yields a part-hour, which would spread a whole-kWh need across more hours than
// the price curve alone would choose; starting on the boundary keeps price the
// only thing deciding which hours are used.
const runTask = (energyNeededKWh: number): HourOutcome[] => {
  const outcomes: HourOutcome[] = [];
  let remainingKWh = energyNeededKWh;
  for (let hourIndex = 0; hourIndex < DEADLINE_HOUR; hourIndex += 1) {
    const nowMs = BASE_MS + hourIndex * HOUR_MS;
    // Producer trajectory gate, computed exactly as `diagnosticsBridge` does in
    // production — never hand-set.
    const aheadOfHourMilestone = isAheadOfHourMilestone({
      energyNeededKWh: remainingKWh,
      committedHours: [],
      nowMs,
    });
    const plan = planDeferredObjectiveHorizon({
      nowMs,
      objective: objective(remainingKWh),
      steps: [STEP],
      buckets: buildBuckets(nowMs),
      // Bootstrap/settle path: the allocator picks the hours afresh from price,
      // which is the decision the "only the cheapest hours" claim is about.
      committed: false,
      committedHours: [],
      aheadOfHourMilestone,
    });
    const diagnostic = diagnosticFor(plan, remainingKWh);
    const decisions = applyDeferredObjectiveAdmission([diagnostic], [device]);
    const decision = decisions.get(DEVICE_ID)!;
    const applied = applyDeferredAdmissionToInput([device], decisions);

    const bookedKWh = plan.currentBucket?.plannedUsefulEnergyKWh ?? 0;
    // A claimed hour runs the device at its committed step for the whole hour; an
    // unclaimed hour is left to the planner, which here has no competing load and
    // no capacity pressure, so the device runs. A released hour delivers nothing.
    const deliveredKWh = decision.kind === 'idle' || decision.kind === 'inactive'
      ? 0
      : STEP.usefulPowerKw;
    remainingKWh = Math.max(0, remainingKWh - deliveredKWh);

    outcomes.push({
      hourIndex,
      price: PRICES[hourIndex]!,
      kind: decision.kind,
      bookedKWh,
      managed: applied.devices[0]?.controllable === true,
      forceShed: applied.forceShedSet.has(DEVICE_ID),
      releaseIntent: decision.releaseIntent,
      deliveredKWh,
    });
  }
  return outcomes;
};

const table = (outcomes: readonly HourOutcome[]): string => outcomes
  .map((o) => `  h${o.hourIndex} @${String(o.price).padStart(3)}  ${o.kind.padEnd(9)} booked ${o.bookedKWh.toFixed(2)} kWh  delivered ${o.deliveredKWh.toFixed(2)} kWh`)
  .join('\n');

describe('an hour the smart task booked nothing into', () => {
  describe('while the booked hours cannot cover the need', () => {
    // 20 kWh against six usable hours of a 1 kW element: the task is short in every
    // hour of the horizon, so there is never a later hour to defer into.
    const outcomes = runTask(20);

    it('is left unclaimed rather than released', () => {
      const unbooked = outcomes.filter((o) => o.bookedKWh <= 0);
      // Fixture guard: the zero-share hours really are the ones that booked nothing,
      // so the assertion below is about the budget share and not about the fill
      // running out of need.
      expect(unbooked.map((o) => o.hourIndex)).toEqual([...ZERO_SHARE_HOURS]);
      expect(
        unbooked.map((o) => o.kind),
        `a task 20 kWh short must not stand its device down.\n${table(outcomes)}`,
      ).toEqual(['unclaimed', 'unclaimed']);
    });

    it('never commands the device off', () => {
      expect(outcomes.some((o) => o.kind === 'idle')).toBe(false);
      expect(outcomes.some((o) => o.forceShed)).toBe(false);
      expect(outcomes.map((o) => o.releaseIntent)).toEqual(outcomes.map(() => undefined));
    });

    it('still hands the device to the planner as managed, so it competes on priority', () => {
      // This is the whole point of `unclaimed`: PELS keeps control of the device and
      // decides by capacity, budget and priority, instead of the task pre-empting
      // that decision with a stand-down.
      expect(outcomes.every((o) => o.managed)).toBe(true);
    });
  });

  describe('once the booked hours cover the need', () => {
    // 2 kWh against a 1 kW element: two hours of runway, and seven to choose from.
    const outcomes = runTask(2);

    it('leaves only the cheapest allocated hours in play', () => {
      const ran = outcomes.filter((o) => o.deliveredKWh > 0).map((o) => o.hourIndex);
      expect(ran, `expected the two cheapest hours only.\n${table(outcomes)}`)
        .toEqual([...CHEAPEST_HOURS]);
      // And the need really was met by them, so the run set is the whole story.
      expect(outcomes.reduce((sum, o) => sum + o.deliveredKWh, 0)).toBeCloseTo(2, 6);
    });

    it('releases the device in every hour it does not need, including the dearer ones', () => {
      const dearer = outcomes.filter((o) => !CHEAPEST_HOURS.includes(o.hourIndex as 2 | 6));
      // `inactive` once the target is met and the objective stops driving the device
      // at all; `idle` while it is still running but does not want this hour.
      expect(
        dearer.map((o) => o.kind),
        `every hour outside the cheapest pair must be given up.\n${table(outcomes)}`,
      ).toEqual(dearer.map((o) => (o.hourIndex > Math.max(...CHEAPEST_HOURS) ? 'inactive' : 'idle')));
      expect(dearer.every((o) => o.deliveredKWh === 0)).toBe(true);
    });

    it('gives up a zero-share hour the same way as a dear one, now that it can', () => {
      // The exact hours that were `unclaimed` while the task was short. Nothing about
      // the budget share changed between the two scenarios — only whether the task
      // could finish without them.
      const zeroShare = outcomes.filter((o) => ZERO_SHARE_HOURS.has(o.hourIndex));
      expect(zeroShare.map((o) => o.kind)).toEqual(['idle', 'idle']);
    });
  });
});
