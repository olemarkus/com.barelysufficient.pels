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
  DeferredObjectivePlanHistoryV2,
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
  energyNeededKWh: 22.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 1.5,
  rateConfidence: 'high',
  kwhPerUnitSource: 'learned',
  horizonBucketCount: 6,
  requestedMinimumStepId: 'low',
  horizonPlan: makeHorizon(),
  ...overrides,
});

const buildPersistDeps = (initial?: DeferredObjectivePlanHistoryV2): {
  deps: PlanHistoryPersistDeps;
  saved: () => DeferredObjectivePlanHistoryV2 | null;
} => {
  let saved: DeferredObjectivePlanHistoryV2 | null = null;
  return {
    deps: {
      load: () => initial ?? null,
      save: (next) => { saved = next; return true; },
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

  it('does not keep a run met when progress drops below target before the deadline', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 65,
      status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 3 * HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 60,
      status: 'on_track',
      horizonPlan: makeHorizon({ status: 'on_track', statusDetail: 'planned_with_margin' }),
    })], 5 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    const entry = saved()!.entries[0]!;
    expect(entry.outcome).toBe('missed');
    expect(entry.metAtMs).toBeNull();
    expect(entry.finalProgressC).toBe(60);
  });

  it('clears a met run when fresh progress drops below target during an unknown cycle', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 65,
      status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 0);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 60,
      status: 'unknown',
      reasonCode: 'objective_missing_price_horizon',
      horizonPlan: undefined,
    })], 5 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    const entry = saved()!.entries[0]!;
    expect(entry.outcome).toBe('missed');
    expect(entry.metAtMs).toBeNull();
    expect(entry.finalProgressC).toBe(60);
  });

  it('clears a met run when fresh progress drops below target while price planning is disabled', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 65,
      status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 0);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 60,
      status: 'unknown',
      reasonCode: 'objective_price_feature_disabled',
      horizonPlan: undefined,
    })], 5 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    const entry = saved()!.entries[0]!;
    expect(entry.outcome).toBe('missed');
    expect(entry.metAtMs).toBeNull();
    expect(entry.finalProgressC).toBe(60);
  });

  it('keeps the last met marker when an unknown cycle only has stale progress', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 65,
      status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 0);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 60,
      status: 'unknown',
      reasonCode: 'objective_progress_stale',
      horizonPlan: undefined,
    })], 5 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    const entry = saved()!.entries[0]!;
    expect(entry.outcome).toBe('met');
    expect(entry.metAtMs).toBe(0);
    expect(entry.finalProgressC).toBe(65);
  });

  it('records the later met time when progress recovers before the deadline', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 65,
      status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 2 * HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 60,
      status: 'on_track',
      horizonPlan: makeHorizon({ status: 'on_track', statusDetail: 'planned_with_margin' }),
    })], 3 * HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs,
      currentTemperatureC: 66,
      status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 5 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    const entry = saved()!.entries[0]!;
    expect(entry.outcome).toBe('met');
    expect(entry.metAtMs).toBe(5 * HOUR_MS);
    expect(entry.finalProgressC).toBe(66);
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

  it('starts a record on first sight of an unknown-status diagnostic with a future deadline', () => {
    // Models the price-horizon-missing case: the diagnostic exists with valid deadline + target
    // + current progress but never becomes plannable. Pre-fix, the recorder dropped these on
    // the floor; now they should finalize as `missed` (progress below target) when the deadline
    // passes.
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, currentTemperatureC: 19, status: 'unknown',
      reasonCode: 'objective_missing_price_horizon', horizonPlan: undefined,
    })], 0);
    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, currentTemperatureC: 22, status: 'unknown',
      reasonCode: 'objective_missing_price_horizon', horizonPlan: undefined,
    })], 3 * HOUR_MS);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    const entries = saved()!.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe('missed');
    expect(entries[0]!.startProgressC).toBe(19);
    expect(entries[0]!.finalProgressC).toBe(19); // unknown diagnostics don't roll forward progress
    expect(entries[0]!.discoveredFrom).toBe('observation');
    expect(entries[0]!.observedIntervals.length).toBeGreaterThan(0);
  });

  it('records a `met` entry when the device is already at target across an unknown-throughout window', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const deadlineAtMs = 6 * HOUR_MS;

    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs, currentTemperatureC: 66, status: 'unknown',
      reasonCode: 'objective_missing_price_horizon', horizonPlan: undefined,
    })], 0);
    recorder.observe([], 6 * HOUR_MS);
    recorder.flushIfDirty();

    const entries = saved()!.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe('met');
  });

  const dayMs = 24 * HOUR_MS;
  const deadlineA = 100 * dayMs;
  const deadlineB = 101 * dayMs;
  const deadlineC = 102 * dayMs;

  it('backfillFromConfig synthesizes one unknown entry per missed one-shot deadline', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    recorder.backfillFromConfig(
      [
        {
          deviceId: 'dev_a',
          deviceName: 'Connected 300',
          objectiveKind: 'temperature',
          deadlineAtMs: deadlineA,
          targetTemperatureC: 65,
          targetPercent: null,
        },
        {
          deviceId: 'dev_b',
          deviceName: 'Pool pump',
          objectiveKind: 'temperature',
          deadlineAtMs: deadlineC,
          targetTemperatureC: 28,
          targetPercent: null,
        },
      ],
      deadlineA - HOUR_MS,
      deadlineC + HOUR_MS,
    );
    recorder.flushIfDirty();

    const entries = saved()!.entries;
    expect(entries.map((e) => e.deadlineAtMs).sort((a, b) => a - b)).toEqual([deadlineA, deadlineC]);
    for (const entry of entries) {
      expect(entry.outcome).toBe('unknown');
      expect(entry.discoveredFrom).toBe('backfill');
      expect(entry.observedIntervals).toEqual([]);
    }
  });

  it('backfillFromConfig skips configs whose deadlineAtMs is outside (fromMs, toMs]', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    recorder.backfillFromConfig(
      [
        // Inside window — included.
        {
          deviceId: 'in_window',
          deviceName: null,
          objectiveKind: 'temperature',
          deadlineAtMs: deadlineB,
          targetTemperatureC: 65,
          targetPercent: null,
        },
        // At fromMs (strict >) — excluded.
        {
          deviceId: 'on_lower_boundary',
          deviceName: null,
          objectiveKind: 'temperature',
          deadlineAtMs: deadlineA,
          targetTemperatureC: 65,
          targetPercent: null,
        },
        // Past toMs — excluded.
        {
          deviceId: 'future',
          deviceName: null,
          objectiveKind: 'temperature',
          deadlineAtMs: deadlineC + HOUR_MS,
          targetTemperatureC: 65,
          targetPercent: null,
        },
      ],
      deadlineA,
      deadlineC,
    );
    recorder.flushIfDirty();

    expect(saved()!.entries.map((e) => e.deviceId)).toEqual(['in_window']);
  });

  it('backfillFromConfig is idempotent across repeated calls', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    const configs = [{
      deviceId: 'dev',
      deviceName: 'Connected 300',
      objectiveKind: 'temperature' as const,
      deadlineAtMs: deadlineA,
      targetTemperatureC: 65,
      targetPercent: null,
    }];
    recorder.backfillFromConfig(configs, deadlineA - HOUR_MS, deadlineA + HOUR_MS);
    recorder.backfillFromConfig(configs, deadlineA - HOUR_MS, deadlineA + HOUR_MS);
    recorder.flushIfDirty();
    expect(saved()!.entries).toHaveLength(1);
  });

  it('backfillFromConfig does not overwrite an observed entry for the same deadline', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
    // Observe and finalize one deadline naturally.
    recorder.observe([makeDiag({
      deviceId: 'dev', deadlineAtMs: deadlineA, currentTemperatureC: 65,
      status: 'satisfied',
      horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], deadlineA - HOUR_MS);
    recorder.observe([], deadlineA);
    recorder.backfillFromConfig(
      [{
        deviceId: 'dev',
        deviceName: 'Connected 300',
        objectiveKind: 'temperature',
        deadlineAtMs: deadlineA,
        targetTemperatureC: 65,
        targetPercent: null,
      }],
      deadlineA - HOUR_MS,
      deadlineA + HOUR_MS,
    );
    recorder.flushIfDirty();
    const entries = saved()!.entries.filter((e) => e.deadlineAtMs === deadlineA);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.discoveredFrom).toBe('observation');
    expect(entries[0]!.outcome).toBe('met');
  });

  it('keeps the recorder dirty and returns false from flushIfDirty when save fails', () => {
    // Save failure must not move the recorder into a clean state — otherwise the watermark
    // in appInit would advance past entries that never landed on disk.
    let saveCalls = 0;
    const recorder = new DeferredObjectivePlanHistoryRecorder({
      load: () => null,
      save: () => {
        saveCalls += 1;
        return false;
      },
    });
    const deadlineAtMs = 6 * HOUR_MS;
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
    recorder.observe([], deadlineAtMs);
    expect(recorder.isDirty()).toBe(true);
    expect(recorder.flushIfDirty()).toBe(false);
    expect(recorder.isDirty()).toBe(true);
    // A second flush attempt retries the save callback rather than silently skipping.
    expect(recorder.flushIfDirty()).toBe(false);
    expect(saveCalls).toBe(2);
  });

  it('hydrates from persisted history on construction', () => {
    const initial: DeferredObjectivePlanHistoryV2 = {
      version: 2,
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
          observedIntervals: [{ fromMs: 0, toMs: HOUR_MS }],
          discoveredFrom: 'observation',
        } satisfies DeferredObjectivePlanHistoryEntry,
      ],
    };
    const recorder = new DeferredObjectivePlanHistoryRecorder({
      load: () => initial,
      save: () => true,
    });
    expect(recorder.getHistorySnapshot().entries).toHaveLength(1);
  });

  describe('finalizeForUserChange', () => {
    it('finalizes the in-progress run as `replaced` when the user picks a new deadline', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const originalDeadline = 6 * HOUR_MS;

      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: originalDeadline, currentTemperatureC: 50 })], 0);
      recorder.finalizeForUserChange('dev', 2 * HOUR_MS, 'replaced');
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('replaced');
      expect(entry.deadlineAtMs).toBe(originalDeadline);
      expect(entry.finalizedAtMs).toBe(2 * HOUR_MS);
      // Same target as the original run; the new deadline starts a separate entry once observed.
      expect(entry.targetTemperatureC).toBe(65);
    });

    it('finalizes as `replaced` when the user keeps the deadline but bumps the target', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs,
        targetTemperatureC: 60,
        currentTemperatureC: 50,
      })], 0);
      recorder.finalizeForUserChange('dev', HOUR_MS, 'replaced');
      // Next cycle: new diagnostic with the bumped target starts a fresh in-progress record.
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs,
        targetTemperatureC: 70,
        currentTemperatureC: 52,
      })], HOUR_MS);
      recorder.observe([], 6 * HOUR_MS); // deadline sweep finalizes the bumped run as `missed`
      recorder.flushIfDirty();

      const entries = saved()!.entries;
      expect(entries).toHaveLength(2);
      const [first, second] = entries;
      expect(first!.outcome).toBe('replaced');
      expect(first!.targetTemperatureC).toBe(60);
      expect(second!.outcome).toBe('missed');
      expect(second!.targetTemperatureC).toBe(70);
    });

    it('finalizes as `abandoned` when the user clears the objective', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.finalizeForUserChange('dev', 30 * 60 * 1000, 'abandoned');
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('abandoned');
      expect(entry.finalizedAtMs).toBe(30 * 60 * 1000);
    });

    it('still reports `met` if the user replaced after the target was already reached', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs,
        currentTemperatureC: 65,
        status: 'satisfied',
        horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
      })], 2 * HOUR_MS);
      recorder.finalizeForUserChange('dev', 3 * HOUR_MS, 'replaced');
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metAtMs).toBe(2 * HOUR_MS);
    });

    it('is a no-op when there is no in-progress run for the device', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);

      recorder.finalizeForUserChange('dev', 0, 'replaced');
      expect(recorder.flushIfDirty()).toBe(false);
      expect(saved()).toBeNull();
    });

    it('does not touch in-progress runs for other devices', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      recorder.observe([
        makeDiag({ deviceId: 'dev-a', deadlineAtMs, currentTemperatureC: 50 }),
        makeDiag({ deviceId: 'dev-b', deadlineAtMs, currentTemperatureC: 40 }),
      ], 0);
      recorder.finalizeForUserChange('dev-a', HOUR_MS, 'abandoned');
      recorder.flushIfDirty();

      const entries = saved()!.entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.deviceId).toBe('dev-a');
      expect(entries[0]!.outcome).toBe('abandoned');
    });
  });
});
