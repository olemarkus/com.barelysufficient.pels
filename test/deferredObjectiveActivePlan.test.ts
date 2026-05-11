import {
  DeferredObjectiveActivePlanRecorder,
  type ActivePlanFlowCardSeed,
  type ActivePlanPersistDeps,
} from '../lib/plan/deferredObjectives/activePlanRecorder';
import type {
  DeferredObjectiveDiagnostic,
  DeferredObjectiveHorizonPlan,
  DeferredObjectivePlannedBucket,
} from '../lib/plan/deferredObjectives';
import type {
  DeferredObjectiveActivePlansV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';

const HOUR_MS = 60 * 60 * 1000;

const makeBucket = (
  startMs: number,
  plannedUsefulEnergyKWh: number,
  overrides: Partial<DeferredObjectivePlannedBucket> = {},
): DeferredObjectivePlannedBucket => ({
  id: `b-${startMs}`,
  sourceBucketId: `s-${startMs}`,
  startMs,
  endMs: startMs + HOUR_MS,
  durationHours: 1,
  preference: 'neutral',
  policyScore: 0,
  reserve: false,
  current: false,
  usefulEnergyCapacityKWh: 3,
  plannedUsefulEnergyKWh,
  ...overrides,
});

const makeHorizon = (
  buckets: DeferredObjectivePlannedBucket[],
  overrides: Partial<DeferredObjectiveHorizonPlan> = {},
): DeferredObjectiveHorizonPlan => {
  const planned = buckets.reduce((sum, b) => sum + b.plannedUsefulEnergyKWh, 0);
  return {
    objectiveId: 'dev:temperature',
    kind: 'temperature',
    enforcement: 'soft',
    status: 'on_track',
    statusDetail: 'planned_with_margin',
    horizonStartMs: buckets[0]?.startMs ?? 0,
    horizonEndMs: buckets.at(-1)?.endMs ?? HOUR_MS,
    planningEndMs: buckets.at(-1)?.endMs ?? HOUR_MS,
    deadlineMarginMs: 0,
    energyNeededKWh: planned,
    plannedUsefulEnergyKWh: planned,
    unplannedUsefulEnergyKWh: 0,
    requestedMinimumStepId: 'low',
    currentBucket: null,
    plannedBuckets: buckets,
    usesDeadlineReserve: false,
    usesPolicyAvoid: false,
    ...overrides,
  };
};

const makeDiag = (overrides: Partial<DeferredObjectiveDiagnostic> & {
  deviceId: string;
  deadlineAtMs: number;
}): DeferredObjectiveDiagnostic => ({
  deviceId: overrides.deviceId,
  deviceName: 'Water Heater',
  objectiveId: `${overrides.deviceId}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  status: 'on_track',
  reasonCode: 'planned_with_margin',
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 65,
  currentTemperatureC: 50,
  deadlineAtMs: overrides.deadlineAtMs,
  deadlineLocalTime: '06:00',
  energyNeededKWh: 4.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 1.5,
  rateConfidence: 'high',
  horizonBucketCount: 3,
  requestedMinimumStepId: 'low',
  horizonPlan: makeHorizon([
    makeBucket(2 * HOUR_MS, 1.5),
    makeBucket(3 * HOUR_MS, 1.5),
    makeBucket(4 * HOUR_MS, 1.5),
  ]),
  ...overrides,
});

const buildSeed = (overrides: Partial<ActivePlanFlowCardSeed> = {}): ActivePlanFlowCardSeed => ({
  deviceId: 'dev',
  deviceName: 'Water Heater',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: 6 * HOUR_MS,
  enforcement: 'soft',
  ...overrides,
});

const buildPersistDeps = (initial?: DeferredObjectiveActivePlansV1): {
  deps: ActivePlanPersistDeps;
  saved: () => DeferredObjectiveActivePlansV1 | null;
} => {
  let saved: DeferredObjectiveActivePlansV1 | null = null;
  return {
    deps: {
      load: () => initial ?? null,
      save: (next) => { saved = next; },
    },
    saved: () => saved,
  };
};

describe('DeferredObjectiveActivePlanRecorder', () => {
  it('writes the first revision on first plannable diagnostic with reason flow_card', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(false);
    expect(plan.original?.revision).toBe(1);
    expect(plan.original?.reason).toBe('flow_card');
    expect(plan.latest?.hours).toEqual([
      { startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 3 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 4 * HOUR_MS, plannedKWh: 1.5 },
    ]);
  });

  it('marks pending when the flow card fires before any horizon plan exists', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.markPending(buildSeed(), 0);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.original).toBeNull();
    expect(plan.latest).toBeNull();
  });

  it('transitions pending -> first revision with prices_arrived when prices show up', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.markPending(buildSeed(), 0);
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(false);
    expect(plan.original?.reason).toBe('prices_arrived');
    expect(plan.latest?.reason).toBe('prices_arrived');
  });

  it('does not write a new revision when subsequent cycles produce identical hours', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    const firstRevision = recorder.getPlanForTests('dev')?.latest?.revision;
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], 2 * HOUR_MS);
    const secondRevision = recorder.getPlanForTests('dev')?.latest?.revision;

    expect(firstRevision).toBe(1);
    expect(secondRevision).toBe(1);
  });

  it('emits an objective_changed revision when the target temperature changes mid-flight', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      targetTemperatureC: 70,
      // Different bucket plan reflects the larger delta:
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 2.0),
        makeBucket(3 * HOUR_MS, 2.0),
        makeBucket(4 * HOUR_MS, 2.0),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('objective_changed');
    expect(plan?.latest?.revision).toBe(2);
    expect(plan?.original?.revision).toBe(1);
    expect(plan?.original?.hours[0]?.plannedKWh).toBe(1.5);
  });

  it('emits a prices_revised revision when the bucket plan shifts but the objective is unchanged', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      // Same target and deadline, different cheap-hour selection:
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('prices_revised');
    expect(plan?.latest?.revision).toBe(2);
    expect(plan?.original?.revision).toBe(1);
  });

  it('drops the record once the deadline passes', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([], 7 * HOUR_MS);
    recorder.flushIfDirty();

    expect(saved()!.plansByDeviceId.dev).toBeUndefined();
  });

  it('keeps the record across a single empty diagnostic cycle (transient SDK miss)', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    // One empty cycle simulates a transient Homey settings read returning empty.
    recorder.observe([], HOUR_MS + 60 * 1000);

    expect(recorder.getPlanForTests('dev')).toBeDefined();
  });

  it('drops the record once the abandon-grace window elapses without the diagnostic', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 10 * HOUR_MS })], HOUR_MS);
    // 1h ABANDON_GRACE_MS — at exactly 1h after last seen, drop fires.
    recorder.observe([], 2 * HOUR_MS);
    recorder.flushIfDirty();

    expect(saved()!.plansByDeviceId.dev).toBeUndefined();
  });

  it('clearForDevice removes the record (clear_deadline flow card)', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.markPending(buildSeed(), 0);
    recorder.clearForDevice('dev');
    recorder.flushIfDirty();

    expect(saved()!.plansByDeviceId.dev).toBeUndefined();
  });

  it('reflects an objective_changed revision when markPending precedes observe with a different target', () => {
    // Regression: markPending on the same deadline must NOT update the stored
    // objectiveSignature, otherwise the next observe() cycle sees matching
    // signatures and writes `prices_revised` (or skips) instead of
    // `objective_changed`. See PR #643 review threads 4 and 6.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // 1. Establish an active plan for target 65 °C.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.latest?.reason).toBe('flow_card');

    // 2. User edits the target via the flow card; markPending fires with a
    //    new target but the same deadline.
    recorder.markPending(buildSeed({ targetTemperatureC: 70 }), 2 * HOUR_MS);

    // 3. The next plan cycle observes a diagnostic with the new target.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      targetTemperatureC: 70,
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 2.0),
        makeBucket(3 * HOUR_MS, 2.0),
        makeBucket(4 * HOUR_MS, 2.0),
      ]),
    })], 3 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('objective_changed');
    expect(plan?.latest?.revision).toBe(2);
    expect(plan?.objectiveSignature).toContain('70');
  });

  it('aggregates trimmed current-bucket segments into the containing hour', () => {
    // Regression: the horizon planner trims the current bucket's start to nowMs
    // and may split a single hour into two segments at planningEndMs. Persist
    // each segment under the floor-of-hour timestamp and sum the energy so the
    // Settings UI can find the planned kWh by the price-horizon hour key.
    // See PR #643 review thread 5.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);
    const hourStart = 2 * HOUR_MS;
    const midHour = hourStart + 23 * 60 * 1000;
    const splitMid = hourStart + 40 * 60 * 1000;

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        // Segment 1: trimmed start (mid-hour) up to the planningEndMs split.
        makeBucket(midHour, 0.4, { endMs: splitMid }),
        // Segment 2: post-split, still inside the same hour.
        makeBucket(splitMid, 0.6, { endMs: hourStart + HOUR_MS }),
        // Next full hour, normal start.
        makeBucket(3 * HOUR_MS, 1.5),
      ]),
    })], midHour);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.hours).toEqual([
      { startsAtMs: hourStart, plannedKWh: 1.0 },
      { startsAtMs: 3 * HOUR_MS, plannedKWh: 1.5 },
    ]);
  });

  it('survives reload by restoring plans from persisted state', () => {
    const persisted: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        dev: {
          deviceId: 'dev',
          deviceName: 'Water Heater',
          objectiveKind: 'temperature',
          targetTemperatureC: 65,
          targetPercent: null,
          deadlineAtMs: 6 * HOUR_MS,
          startedAtMs: 0,
          pending: false,
          objectiveSignature: '["temperature",65,null,21600000,"soft"]',
          original: {
            revision: 1,
            revisedAtMs: HOUR_MS,
            computedFromPricesUpTo: 5 * HOUR_MS,
            reason: 'flow_card',
            hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 }],
          },
          latest: {
            revision: 1,
            revisedAtMs: HOUR_MS,
            computedFromPricesUpTo: 5 * HOUR_MS,
            reason: 'flow_card',
            hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 }],
          },
        },
      },
    };
    const { deps } = buildPersistDeps(persisted);
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);
    expect(recorder.getActivePlansSnapshot().plansByDeviceId.dev?.latest?.revision).toBe(1);
  });
});
