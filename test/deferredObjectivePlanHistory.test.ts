import {
  DeferredObjectivePlanHistoryRecorder,
  type PlanHistoryPersistDeps,
} from '../lib/plan/deferredObjectives/planHistory';
import type {
  DeferredObjectiveDiagnostic,
  DeferredObjectiveHorizonPlan,
} from '../lib/plan/deferredObjectives';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryV1,
} from '../packages/contracts/src/deferredObjectivePlanHistory';

const HOUR_MS = 60 * 60 * 1000;

const makeHorizon = (
  overrides: Partial<DeferredObjectiveHorizonPlan> = {},
): DeferredObjectiveHorizonPlan => ({
  objectiveId: 'dev:temperature',
  kind: 'temperature',
  enforcement: 'soft',
  status: 'on_track',
  statusDetail: 'planned_with_margin',
  horizonStartMs: 0,
  horizonEndMs: 6 * HOUR_MS,
  planningEndMs: 6 * HOUR_MS,
  deadlineMarginMs: 0,
  energyNeededKWh: 1.5,
  plannedUsefulEnergyKWh: 1.5,
  unplannedUsefulEnergyKWh: 0,
  requestedMinimumStepId: 'low',
  currentBucket: null,
  plannedBuckets: [],
  usesDeadlineReserve: false,
  usesPolicyAvoid: false,
  ...overrides,
});

const makeDiag = (
  overrides: Partial<DeferredObjectiveDiagnostic> & { deviceId: string; deadlineAtMs: number },
): DeferredObjectiveDiagnostic => ({
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
  deadlineRollsToNextDay: false,
  energyNeededKWh: 22.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 1.5,
  rateConfidence: 'high',
  horizonBucketCount: 6,
  requestedMinimumStepId: 'low',
  horizonPlan: makeHorizon(),
  ...overrides,
});

const buildPersistDeps = (initial?: DeferredObjectivePlanHistoryV1): {
  deps: PlanHistoryPersistDeps;
  saved: () => DeferredObjectivePlanHistoryV1 | null;
} => {
  let saved: DeferredObjectivePlanHistoryV1 | null = null;
  return {
    deps: {
      load: () => initial ?? null,
      save: (next) => { saved = next; },
    },
    saved: () => saved,
  };
};

describe('DeferredObjectivePlanHistoryRecorder', () => {
  it('finalizes a run as `met` when status reaches satisfied during the horizon', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 60 })], 3 * HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 65,
      status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 4 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS); // deadline-passed sweep
    recorder.flushIfDirty();

    const persisted = saved();
    expect(persisted?.entries).toHaveLength(1);
    const entry = persisted!.entries[0]!;
    expect(entry.outcome).toBe('met');
    expect(entry.metAtMs).toBe(4 * HOUR_MS);
    expect(entry.startProgressC).toBe(50);
    expect(entry.finalProgressC).toBe(65);
    expect(entry.finalizedAtMs).toBe(6 * HOUR_MS);
  });

  it('finalizes as `missed` when the deadline passes with progress below target', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 55 })], 3 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS); // deadline-passed sweep, target was 65 °C
    recorder.flushIfDirty();

    const entry = saved()!.entries[0]!;
    expect(entry.outcome).toBe('missed');
    expect(entry.metAtMs).toBeNull();
    expect(entry.finalProgressC).toBe(55);
  });

  it('preserves `usedPolicyAvoid` once a backup hour was used and rolls it into the entry', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, horizonPlan: makeHorizon({ usesPolicyAvoid: false }),
    })], 0);
    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, horizonPlan: makeHorizon({ usesPolicyAvoid: true }),
    })], 3 * HOUR_MS);
    // Subsequent cycle without the avoid flag must not flip it back to false.
    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, horizonPlan: makeHorizon({ usesPolicyAvoid: false }),
    })], 4 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    expect(saved()!.entries[0]!.usedPolicyAvoid).toBe(true);
  });

  it('finalizes as `abandoned` when the diagnostic disappears before the deadline', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs })], 0);
    // Diagnostic stops appearing at hour 1; abandon grace is 1 hour, so by hour 3 the run is abandoned.
    recorder.observe([], 3 * HOUR_MS);
    recorder.flushIfDirty();

    const entry = saved()!.entries[0]!;
    expect(entry.outcome).toBe('abandoned');
    expect(entry.finalizedAtMs).toBe(3 * HOUR_MS);
  });

  it('keeps an in-progress run alive across transient unknown statuses', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
    // Two cycles of unknown — should refresh lastSeenAtMs so the abandon grace doesn't trip.
    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, status: 'unknown', horizonPlan: undefined,
    })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, status: 'unknown', horizonPlan: undefined,
    })], 2 * HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, currentTemperatureC: 65, status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 3 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    const entries = saved()!.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe('met');
  });

  it('treats two diagnostics with different deadlineAtMs as separate runs', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);

    // Day 1: deadline at 6h, goal met.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS, currentTemperatureC: 50 })], 0);
    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS, currentTemperatureC: 65, status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 4 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS); // first run finalized.
    // Day 2: new deadline at 30h, goal missed.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 30 * HOUR_MS, currentTemperatureC: 50 })], 24 * HOUR_MS);
    recorder.observe([], 30 * HOUR_MS);
    recorder.flushIfDirty();

    const entries = saved()!.entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.outcome).toBe('met');
    expect(entries[0]!.deadlineAtMs).toBe(6 * HOUR_MS);
    expect(entries[1]!.outcome).toBe('missed');
    expect(entries[1]!.deadlineAtMs).toBe(30 * HOUR_MS);
  });

  it('caps the rolling buffer to 30 entries, dropping the oldest', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    for (let i = 0; i < 35; i += 1) {
      const dayStart = i * 24 * HOUR_MS;
      const deadline = dayStart + 6 * HOUR_MS;
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: deadline })], dayStart);
      recorder.observe([], deadline);
    }
    recorder.flushIfDirty();

    const entries = saved()!.entries;
    expect(entries).toHaveLength(30);
    // Oldest entry should now be from cycle index 5 (35 total - 30 kept).
    expect(entries[0]!.deadlineAtMs).toBe(5 * 24 * HOUR_MS + 6 * HOUR_MS);
    expect(entries[entries.length - 1]!.deadlineAtMs).toBe(34 * 24 * HOUR_MS + 6 * HOUR_MS);
  });

  it('does not start a new record when the diagnostic\'s deadline has already passed', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);

    // Diagnostic shows up with a deadline that is already in the past relative to nowMs.
    // Without the guard this would start a record and immediately finalize it on the same
    // cycle, leaving a garbage entry behind.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 5 * HOUR_MS,
    })], 6 * HOUR_MS);
    recorder.flushIfDirty();

    expect(saved()).toBeNull();
  });

  it('hydrates from persisted history on construction', () => {
    const initial: DeferredObjectivePlanHistoryV1 = {
      version: 1,
      entries: [
        {
          deviceId: 'dev',
          deviceName: 'Water Heater',
          objectiveKind: 'temperature',
          targetTemperatureC: 65,
          targetPercent: null,
          deadlineAtMs: HOUR_MS,
          startedAtMs: 0,
          finalizedAtMs: HOUR_MS,
          startProgressC: 50,
          startProgressPercent: null,
          finalProgressC: 65,
          finalProgressPercent: null,
          initialEnergyNeededKWh: 22.5,
          outcome: 'met',
          metAtMs: HOUR_MS - 1,
          usedDeadlineReserve: false,
          usedPolicyAvoid: false,
        } satisfies DeferredObjectivePlanHistoryEntry,
      ],
    };
    const recorder = new DeferredObjectivePlanHistoryRecorder({
      load: () => initial,
      save: () => undefined,
    });
    expect(recorder.getHistorySnapshot().entries).toHaveLength(1);
  });
});
