// End-to-end schedule simulation for a smart task whose device under-delivers
// and runs past its committed hour window. It drives the REAL planner
// (`planDeferredObjectiveHorizon`) into the REAL active-plan recorder
// (`DeferredObjectiveActivePlanRecorder`) hour by hour, feeding each cycle's
// committed schedule back via the REAL `resolveCommittedHours`. No device /
// profile bridge: the per-hour energy need is supplied directly by a physics
// model so the test isolates the schedule pipeline (planner allocator +
// commitment merge + committed read-back).
//
// It guards against a production miss (Connected 300 water heater, 2026-05-31):
// the heater climbed to ~target inside its cheap committed window, the heater's
// own thermostat then cut the element, and the tank cooled afterwards. Once the
// committed hours had elapsed, the first hour in which the need REGREW was the
// current hour. That hour USED to be stranded at 0 kWh — phase-2 expansion
// skipped the current bucket and the commitment merge could only adopt an hour
// while it was still a FUTURE hour, so the device was turned off while behind
// target. The fix (`bucketAllocation.expandCommittedAllocation`) fills an
// UNCOMMITTED current bucket cheapest-first, so the device stays on and the
// served hour self-commits. "Commit the upcoming hour at the boundary" could
// not have caught this case: the need regrows only once the hour is current.
//
// Two cases:
//  1. Regression pin for `f9809995` (commitment extends forward after an early
//     committed hour elapses) — a still-needy task keeps getting its current
//     hour served and the committed set keeps growing.
//  2. Regression for the strand fix — the first regrown hour after the committed
//     window is served (not stranded), and self-commits.
import {
  DeferredObjectiveActivePlanRecorder,
  type ActivePlanFlowCardSeed,
  type ActivePlanPersistDeps,
} from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import { resolveCommittedHours } from '../../lib/objectives/deferredObjectives/resolveCommittedHours';
import {
  planDeferredObjectiveHorizon,
} from '../../lib/objectives/deferredObjectives';
import type {
  DeferredObjective,
  DeferredObjectiveDiagnostic,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveStep,
} from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectiveSettingsEntry } from '../../lib/objectives/deferredObjectives/settings';

const HOUR_MS = 60 * 60 * 1000;
const BASE_HOUR = Date.UTC(2026, 4, 30, 20); // 22:00 local-ish; absolute, DST-agnostic
// The recorder settles a replan revision once per clock hour, at/after :58, so
// each simulated cycle ticks at the :58 mark of its hour to exercise the settle.
const SCHEDULE_SETTLE_OFFSET_MS = 58 * 60 * 1000;
const STEP: DeferredObjectiveStep = { id: 'low', usefulPowerKw: 1.25 };

const TARGET_TEMPERATURE_C = 65;
const DEVICE_ID = 'water-heater';

// Hourly price-horizon buckets from `nowMs` to the deadline. The planner trims
// the current bucket's start to `nowMs` and tags reserve/current internally.
const bucketsTo = (nowMs: number, deadlineAtMs: number): DeferredObjectiveHorizonBucket[] => {
  const buckets: DeferredObjectiveHorizonBucket[] = [];
  for (let h = Math.floor(nowMs / HOUR_MS) * HOUR_MS; h < deadlineAtMs; h += HOUR_MS) {
    buckets.push({
      id: new Date(h).toISOString(),
      startMs: Math.max(h, nowMs),
      endMs: h + HOUR_MS,
    });
  }
  return buckets;
};

const settingsEntry = (deadlineAtMs: number): DeferredObjectiveSettingsEntry => ({
  kind: 'temperature',
  targetTemperatureC: TARGET_TEMPERATURE_C,
  deadlineAtMs,
  enforcement: 'soft',
});

const objective = (deadlineAtMs: number, energyNeededKWh: number): DeferredObjective => ({
  id: `${DEVICE_ID}:temperature`,
  kind: 'temperature',
  enforcement: 'soft',
  energyNeededKWh,
  deadlineAtMs,
});

const seed = (deadlineAtMs: number): ActivePlanFlowCardSeed => ({
  deviceId: DEVICE_ID,
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: TARGET_TEMPERATURE_C,
  targetPercent: null,
  deadlineAtMs,
});

const diagnosticFor = (
  plan: DeferredObjectiveHorizonPlan,
  deadlineAtMs: number,
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
  targetTemperatureC: TARGET_TEMPERATURE_C,
  currentTemperatureC: 60,
  deadlineAtMs,
  deadlineLocalTime: '06:00',
  energyNeededKWh,
  kWhPerUnitBanded: 1.5,
  rateConfidence: 'high',
  kwhPerUnitSource: 'learned',
  horizonBucketCount: plan.plannedBuckets.length,
  dailyBudgetExhaustedBucketCount: 0,
  expectedStepId: plan.expectedStepId,
  horizonPlan: plan,
});

type HourRecord = {
  hourIndex: number;
  status: DeferredObjectiveHorizonPlan['status'];
  needKWh: number;
  currentBucketKWh: number;
  committedHourIndexes: number[];
};

// Drive the planner -> recorder -> resolveCommittedHours loop for `hours` ticks.
// `nextNeed` is the physics model: given the hour index, the energy planned for
// the current bucket, and the current need, it returns the need for the next
// hour (i.e. it simulates delivery and/or standby cooling).
const runSimulation = (params: {
  hours: number;
  deadlineHourIndex: number;
  initialNeedKWh: number;
  nextNeed: (ctx: { hourIndex: number; plannedCurrentKWh: number; needKWh: number }) => number;
}): HourRecord[] => {
  const deadlineAtMs = BASE_HOUR + params.deadlineHourIndex * HOUR_MS;
  let persisted: ReturnType<ActivePlanPersistDeps['load']> = null;
  const deps: ActivePlanPersistDeps = {
    load: () => persisted,
    save: (next) => { persisted = next; },
  };
  const recorder = new DeferredObjectiveActivePlanRecorder(deps);
  // A Flow trigger seeds the task one minute before the first plan cycle.
  recorder.markPending(seed(deadlineAtMs), BASE_HOUR - 60_000);

  const records: HourRecord[] = [];
  let needKWh = params.initialNeedKWh;
  for (let hourIndex = 0; hourIndex < params.hours; hourIndex += 1) {
    const nowMs = BASE_HOUR + hourIndex * HOUR_MS + SCHEDULE_SETTLE_OFFSET_MS;
    const committedHours = resolveCommittedHours({
      activePlans: recorder.getActivePlansSnapshot(),
      deviceId: DEVICE_ID,
      objective: settingsEntry(deadlineAtMs),
    });
    const plan = planDeferredObjectiveHorizon({
      nowMs,
      objective: objective(deadlineAtMs, needKWh),
      steps: [STEP],
      buckets: bucketsTo(nowMs, deadlineAtMs),
      committed: committedHours !== undefined,
      committedHours,
    });
    recorder.observe([diagnosticFor(plan, deadlineAtMs, needKWh)], nowMs);

    const committedAfter = resolveCommittedHours({
      activePlans: recorder.getActivePlansSnapshot(),
      deviceId: DEVICE_ID,
      objective: settingsEntry(deadlineAtMs),
    }) ?? [];
    records.push({
      hourIndex,
      status: plan.status,
      needKWh,
      currentBucketKWh: plan.currentBucket?.plannedUsefulEnergyKWh ?? 0,
      committedHourIndexes: committedAfter
        .map((h) => Math.round((h.startsAtMs - BASE_HOUR) / HOUR_MS))
        .sort((a, b) => a - b),
    });

    needKWh = params.nextNeed({ hourIndex, plannedCurrentKWh: plan.currentBucket?.plannedUsefulEnergyKWh ?? 0, needKWh });
  }
  return records;
};

describe('smart-task commitment rollover simulation', () => {
  // Regression pin for f9809995: once an early committed hour elapses, the
  // schedule must still adopt newly-planned future hours, and the current hour
  // must keep being served while the task still needs energy.
  it('keeps serving the current hour and extends the commitment forward as hours elapse', () => {
    const records = runSimulation({
      hours: 6,
      deadlineHourIndex: 8,
      initialNeedKWh: 5,
      // Device never delivers (need held constant): the task keeps needing
      // energy every hour, so every current hour should be served and the
      // commitment should keep extending to cover newly-current hours.
      nextNeed: ({ needKWh }) => needKWh,
    });

    for (const record of records) {
      expect(record.currentBucketKWh).toBeGreaterThan(0);
    }
    // The committed set grew beyond the initial window rather than freezing.
    const lastRecord = records[records.length - 1]!;
    const lastCommitted = lastRecord.committedHourIndexes;
    expect(Math.max(...lastCommitted)).toBeGreaterThanOrEqual(lastRecord.hourIndex);
    expect(lastCommitted.length).toBeGreaterThan(records[0]!.committedHourIndexes.length);
  });

  // Regression for the current-hour strand fix (the production miss shape): the
  // device satisfies inside its committed window, then stalls and the need
  // REGROWS in the first hour after the window has elapsed. That hour is
  // current-and-uncommitted — it was never planned ahead (need was ~0 when it
  // was still a future hour), so committing the upcoming hour at the boundary
  // could not have caught it; the regrowth only appears once it is current.
  //
  // Before the fix, phase-2 expansion skipped the current bucket
  // (`if (bucket.current) continue`), so this hour was stranded at 0 kWh and the
  // device was turned off while still behind target. The fix lets expansion fill
  // an UNCOMMITTED current bucket, so the hour is served and the device stays on
  // (and the served hour self-commits for subsequent cycles).
  it('serves — does not strand — the first regrown hour after the committed window elapses', () => {
    let stalled = false;
    const records = runSimulation({
      hours: 8,
      deadlineHourIndex: 8,
      initialNeedKWh: 4,
      nextNeed: ({ hourIndex, plannedCurrentKWh, needKWh }) => {
        // Hours 0-2: heater delivers the planned current-bucket energy.
        // From hour 3 the heater's own thermostat cuts the element (stall), and
        // the tank cools, regrowing the need ~0.6 kWh/h.
        const delivered = stalled ? 0 : plannedCurrentKWh;
        let next = Math.max(0.2, needKWh - delivered);
        if (hourIndex >= 3) stalled = true;
        if (stalled) next += 0.6;
        return next;
      },
    });

    // The committed window settled on the early cheap hours (~0-3). Identify the
    // first hour after the window in which the need has regrown.
    const boundaryHour = records.find((r) => r.hourIndex >= 4 && r.needKWh > 0.2);
    expect(boundaryHour).toBeDefined();

    // No hour with remaining need is left stranded at 0 kWh while on_track — the
    // pre-fix strand is gone.
    const stranded = records.filter(
      (r) => r.needKWh > 0.2 && r.status === 'on_track' && r.currentBucketKWh === 0,
    );
    expect(stranded).toEqual([]);

    // The boundary hour is served (device kept on) and self-commits so later
    // cycles serve it from the committed phase-1.
    expect(boundaryHour!.currentBucketKWh).toBeGreaterThan(0);
    expect(boundaryHour!.committedHourIndexes).toContain(boundaryHour!.hourIndex);
  });
});
