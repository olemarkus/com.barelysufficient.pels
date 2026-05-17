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
  DeferredObjectivePlanHistoryV4,
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
  dailyBudgetExhaustedBucketCount: 0,
  requestedMinimumStepId: 'low',
  horizonPlan: makeHorizon(),
  ...overrides,
});

const buildPersistDeps = (initial?: DeferredObjectivePlanHistoryV4): {
  deps: PlanHistoryPersistDeps;
  saved: () => DeferredObjectivePlanHistoryV4 | null;
} => {
  let saved: DeferredObjectivePlanHistoryV4 | null = null;
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

  it('publishes ended events to the bus on finalization for met / missed / abandoned only', () => {
    // Three runs in parallel: one reaches target, one misses, one disappears.
    // A fourth user-replace and a backfilled entry must stay quiet.
    const events: Array<{ deviceId: string; outcome: string }> = [];
    const { deps: persist } = buildPersistDeps();
    const recorder = new DeferredObjectivePlanHistoryRecorder({
      ...persist,
      endedBus: {
        publish: (event) => events.push({ deviceId: event.deviceId, outcome: event.outcome }),
        onEnded: () => () => undefined,
      },
    });
    const deadlineAtMs = 6 * HOUR_MS;

    // met: hits target during the run.
    recorder.observe([makeDiag({
      deviceId: 'met-dev', deadlineAtMs, status: 'satisfied', currentTemperatureC: 70,
    })], HOUR_MS);
    // missed: progress stays below target until the deadline sweep.
    recorder.observe([makeDiag({
      deviceId: 'missed-dev', deadlineAtMs, currentTemperatureC: 55,
    })], HOUR_MS);
    // abandoned-via-user: cleared explicitly.
    recorder.observe([makeDiag({ deviceId: 'abandoned-dev', deadlineAtMs })], HOUR_MS);
    recorder.finalizeForUserChange('abandoned-dev', 2 * HOUR_MS, 'abandoned');
    // replaced-via-user: must NOT publish (run continues under new params).
    recorder.observe([makeDiag({ deviceId: 'replaced-dev', deadlineAtMs })], HOUR_MS);
    recorder.finalizeForUserChange('replaced-dev', 2 * HOUR_MS, 'replaced');
    // Deadline sweep finalizes the met and missed runs.
    recorder.observe([], 6 * HOUR_MS);

    expect(events).toEqual([
      { deviceId: 'abandoned-dev', outcome: 'abandoned' },
      { deviceId: 'met-dev', outcome: 'succeeded' },
      { deviceId: 'missed-dev', outcome: 'missed' },
    ]);

    // Backfill entries describe deadlines that elapsed before PELS observed
    // them — they must never reach the bus retroactively.
    recorder.backfillFromConfig([{
      deviceId: 'backfill-dev',
      deviceName: 'Back-filled',
      objectiveKind: 'temperature',
      deadlineAtMs: 5 * HOUR_MS,
      targetTemperatureC: 65,
      targetPercent: null,
    }], 0, 7 * HOUR_MS);
    expect(events).toHaveLength(3);
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
    const initial: DeferredObjectivePlanHistoryV4 = {
      version: 4,
      entries: [
        {
          id: 'hydration-entry-1',
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
          originalPlan: null,
          finalPlan: null,
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

  describe('v3 plan snapshots', () => {
    const buildActivePlans = (
      params: { deviceId: string; deadlineAtMs: number; originalKwh?: number; latestKwh?: number },
    ) => ({
      version: 1 as const,
      plansByDeviceId: {
        [params.deviceId]: {
          deviceId: params.deviceId,
          deviceName: 'Water Heater',
          objectiveKind: 'temperature' as const,
          targetTemperatureC: 65,
          targetPercent: null,
          deadlineAtMs: params.deadlineAtMs,
          startedAtMs: 0,
          pending: false,
          objectiveSignature: 'sig',
          original: {
            revision: 1,
            revisedAtMs: 0,
            computedFromPricesUpTo: null,
            reason: 'flow_card' as const,
            hours: [{ startsAtMs: 0, plannedKWh: params.originalKwh ?? 1.0 }],
            energyNeededKWh: 2.0,
            planStatus: 'on_track' as const,
          },
          latest: {
            revision: 2,
            revisedAtMs: HOUR_MS,
            computedFromPricesUpTo: null,
            reason: 'prices_revised' as const,
            hours: [{ startsAtMs: HOUR_MS, plannedKWh: params.latestKwh ?? 2.0 }],
            energyNeededKWh: 2.0,
            planStatus: 'on_track' as const,
          },
        },
      },
    });

    it('captures original + final plan snapshots and assigns a stable uuid on finalize', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      // First cycle: only original revision exists (latest matches it). The recorder should
      // capture this as both original and final at start time.
      const firstPlans = buildActivePlans({ deviceId: 'dev', deadlineAtMs, originalKwh: 1.0, latestKwh: 1.0 });
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })],
        0,
        firstPlans,
      );
      // Second cycle: replanning produced a different `latest`. The final snapshot must
      // reflect the new latest while the original snapshot stays at the first observed plan.
      const revisedPlans = buildActivePlans({ deviceId: 'dev', deadlineAtMs, originalKwh: 1.0, latestKwh: 3.5 });
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 60 })],
        2 * HOUR_MS,
        revisedPlans,
      );
      // Deadline sweep finalizes the run.
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(10);
      expect(entry.originalPlan).not.toBeNull();
      expect(entry.finalPlan).not.toBeNull();
      // Original captured at first observation: 1.0 kWh in hour 0.
      expect(entry.originalPlan!.hours[0]!.plannedKWh).toBeCloseTo(1.0);
      // Final reflects the revised latest: 3.5 kWh in hour 1.
      expect(entry.finalPlan!.hours[0]!.plannedKWh).toBeCloseTo(3.5);
    });

    it('adopts a richer latest as originalPlan when the planner expands the schedule mid-run', () => {
      // Regression: a run where the planner's first written revision is a degenerate
      // 1-hour allocation (prices arrived late) but a later replan expands to a full
      // 8-hour schedule. The recorded `originalPlan` must reflect the richer
      // intent ("we wanted 8 charging hours") rather than the first poor revision.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 9 * HOUR_MS;

      const skinnyPlans = {
        version: 1 as const,
        plansByDeviceId: {
          dev: {
            deviceId: 'dev',
            deviceName: 'EV',
            objectiveKind: 'ev_soc' as const,
            targetTemperatureC: null,
            targetPercent: 80,
            deadlineAtMs,
            startedAtMs: 0,
            pending: false,
            objectiveSignature: 'sig',
            original: {
              revision: 1, revisedAtMs: 0, computedFromPricesUpTo: null,
              reason: 'prices_arrived' as const,
              hours: [{ startsAtMs: 8 * HOUR_MS, plannedKWh: 2.0 }],
              energyNeededKWh: 2.0, planStatus: 'cannot_meet' as const,
            },
            latest: {
              revision: 1, revisedAtMs: 0, computedFromPricesUpTo: null,
              reason: 'prices_arrived' as const,
              hours: [{ startsAtMs: 8 * HOUR_MS, plannedKWh: 2.0 }],
              energyNeededKWh: 2.0, planStatus: 'cannot_meet' as const,
            },
          },
        },
      };
      const richPlans = {
        ...skinnyPlans,
        plansByDeviceId: {
          dev: {
            ...skinnyPlans.plansByDeviceId.dev,
            latest: {
              revision: 2, revisedAtMs: HOUR_MS, computedFromPricesUpTo: null,
              reason: 'prices_revised' as const,
              hours: Array.from({ length: 8 }, (_, i) => ({
                startsAtMs: (i + 1) * HOUR_MS, plannedKWh: 1.5,
              })),
              energyNeededKWh: 12.0, planStatus: 'on_track' as const,
            },
          },
        },
      };
      const collapsedPlans = {
        ...skinnyPlans,
        plansByDeviceId: {
          dev: {
            ...skinnyPlans.plansByDeviceId.dev,
            latest: {
              revision: 3, revisedAtMs: 7 * HOUR_MS, computedFromPricesUpTo: null,
              reason: 'prices_revised' as const,
              hours: [{ startsAtMs: 8 * HOUR_MS, plannedKWh: 1.5 }],
              energyNeededKWh: 1.5, planStatus: 'cannot_meet' as const,
            },
          },
        },
      };

      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentPercent: 30 })], 0, skinnyPlans);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentPercent: 35 })], HOUR_MS, richPlans);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentPercent: 40 })], 7 * HOUR_MS, collapsedPlans);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.originalPlan).not.toBeNull();
      // The richest schedule the planner ever produced was 8 hours — preserve it
      // so the past-plan view can show what the run was aiming for.
      expect(entry.originalPlan!.hours).toHaveLength(8);
      // Final reflects the actually-executed shape: collapsed back to 1 hour.
      expect(entry.finalPlan!.hours).toHaveLength(1);
    });

    it('leaves plan snapshots null when no active plan exists during observation', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.originalPlan).toBeNull();
      expect(entry.finalPlan).toBeNull();
      // Without a plan we never observed a revision; the field stays absent so
      // legacy entries persisted before this field shipped remain byte-stable.
      expect(entry.revisionCount).toBeUndefined();
    });

    it('captures the recorder revision count on the entry so the history detail can render "Replanned N times"', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      const plans = buildActivePlans({ deviceId: 'dev', deadlineAtMs, originalKwh: 1.0, latestKwh: 2.0 });
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0, plans);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      // `buildActivePlans` sets `latest.revision = 2` so the count tracks
      // "original + 1 replan" — the UI renders this as "Replanned once".
      expect(entry.revisionCount).toBe(2);
    });

    it('does not write revisionCount when the run never had a plannable revision', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      // No `activePlans` argument: recorder never sees a revision.
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      expect(saved()!.entries[0]!.revisionCount).toBeUndefined();
    });

    it('assigns distinct ids to entries finalized at the same millisecond', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      recorder.observe([
        makeDiag({ deviceId: 'dev-a', deadlineAtMs, currentTemperatureC: 50 }),
        makeDiag({ deviceId: 'dev-b', deadlineAtMs, currentTemperatureC: 40 }),
      ], 0);
      recorder.observe([], deadlineAtMs); // both finalize on the same sweep
      recorder.flushIfDirty();

      const entries = saved()!.entries;
      expect(entries).toHaveLength(2);
      expect(entries[0]!.id).not.toBe(entries[1]!.id);
    });
  });

  // Regression: live-Homey walk on 2026-05-16 found the four most recent past
  // entries for Connected 300 rendered as device-only rows because
  // `formatPlanHistoryProgressLine` returns null when `startProgressC` is null.
  // Root cause: `startRecord` stamps `startProgressC` once at create time and
  // never back-fills, so a run that begins with a null diagnostic (transient
  // SDK miss / `objective_progress_stale` / `objective_missing_temperature`)
  // keeps the field null for the lifetime of the run even when later cycles
  // report a real reading. See TODO.md P0 item 5 and notes/smart-task-ui/README.md.
  describe('back-fills start progress from the first non-null observation', () => {
    it('temperature path: stamps `startProgressC` once a real reading arrives', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      // First cycle: diagnostic reports the deadline + target but no
      // `currentTemperatureC` yet (Homey SDK temperature read transiently
      // failed; the bridge surfaces `objective_missing_temperature` with
      // current = null). Without the fix `startProgressC` is captured as
      // null and stays null forever.
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs,
        currentTemperatureC: null,
        status: 'unknown',
        reasonCode: 'objective_missing_temperature',
        horizonPlan: undefined,
      })], 0);
      // Second cycle: device is back, planner produces a real allocation.
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs,
        currentTemperatureC: 52,
        status: 'on_track',
      })], HOUR_MS);
      // Third cycle: continues with a richer reading — must NOT overwrite the
      // back-filled start value (start is "first real reading", not "latest").
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs,
        currentTemperatureC: 60,
        status: 'on_track',
      })], 3 * HOUR_MS);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.startProgressC).toBe(52); // first real reading wins
      expect(entry.finalProgressC).toBe(60);
      expect(entry.observedIntervals.length).toBeGreaterThan(0);
    });

    it('temperature path: a transient null cycle in the middle does not clear an already-set start', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      // Start with a real reading.
      recorder.observe([makeDiag({
        deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50, status: 'on_track',
      })], 0);
      // Mid-run SDK miss.
      recorder.observe([makeDiag({
        deviceId: 'dev', deadlineAtMs, currentTemperatureC: null, status: 'unknown',
        reasonCode: 'objective_progress_stale', horizonPlan: undefined,
      })], HOUR_MS);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      expect(saved()!.entries[0]!.startProgressC).toBe(50);
    });

    it('EV path: stamps `startProgressPercent` once a real percent arrives', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 9 * HOUR_MS;

      // First cycle: EV charging session not yet known (e.g. plug-state still
      // settling, `currentPercent` null). The diagnostic carries the deadline
      // and target but no progress.
      recorder.observe([makeDiag({
        deviceId: 'ev',
        deadlineAtMs,
        objectiveKind: 'ev_soc',
        objectiveId: 'ev:ev_soc',
        targetTemperatureC: null,
        currentTemperatureC: null,
        targetPercent: 80,
        currentPercent: null,
        status: 'unknown',
        reasonCode: 'objective_progress_stale',
        horizonPlan: undefined,
      })], 0);
      // Second cycle: SoC is now fresh.
      recorder.observe([makeDiag({
        deviceId: 'ev',
        deadlineAtMs,
        objectiveKind: 'ev_soc',
        objectiveId: 'ev:ev_soc',
        targetTemperatureC: null,
        currentTemperatureC: null,
        targetPercent: 80,
        currentPercent: 35,
        status: 'on_track',
      })], HOUR_MS);
      recorder.observe([makeDiag({
        deviceId: 'ev',
        deadlineAtMs,
        objectiveKind: 'ev_soc',
        objectiveId: 'ev:ev_soc',
        targetTemperatureC: null,
        currentTemperatureC: null,
        targetPercent: 80,
        currentPercent: 70,
        status: 'on_track',
      })], 6 * HOUR_MS);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.startProgressPercent).toBe(35); // first real reading wins
      expect(entry.finalProgressPercent).toBe(70);
      expect(entry.observedIntervals.length).toBeGreaterThan(0);
    });

    it('non-plannable cycles also back-fill start progress when a fresh reading arrives', () => {
      // `objective_missing_price_horizon` is non-plannable but carries a fresh
      // `currentTemperatureC`. The non-plannable tick path must also adopt
      // the first real reading as `startProgressC`.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      recorder.observe([makeDiag({
        deviceId: 'dev', deadlineAtMs, currentTemperatureC: null,
        status: 'unknown', reasonCode: 'objective_missing_temperature',
        horizonPlan: undefined,
      })], 0);
      recorder.observe([makeDiag({
        deviceId: 'dev', deadlineAtMs, currentTemperatureC: 48,
        status: 'unknown', reasonCode: 'objective_missing_price_horizon',
        horizonPlan: undefined,
      })], HOUR_MS);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      expect(saved()!.entries[0]!.startProgressC).toBe(48);
    });
  });

  // PR 1 of the v2.7.2 train added four optional fields to the history entry:
  // `progressSamples`, `deliveredKWh` + `totalCost`, and `revisions[]`, plus
  // `kwhPerUnitMean` on the revision snapshot. The tests below cover the
  // recorder side of each addition. UI consumption is the subject of later
  // PRs in the train.
  describe('v4 history-detail trio', () => {
    const buildActivePlansV4 = (params: {
      deviceId: string;
      deadlineAtMs: number;
      latestRevision: number;
      latestRevisedAtMs: number;
      latestReason?: 'flow_card' | 'prices_arrived' | 'prices_revised' | 'rate_refined' | 'objective_changed';
      latestHourStarts: number[];
      originalHourStarts?: number[];
      kwhPerUnit?: number | null;
      // Mirrors `DeferredObjectiveActivePlanRevisionV1.dailyBudgetExhaustedBucketCount`
      // — applied to the latest revision so v2.7.2 PR 3 can assert the
      // snapshot capture path. Original revision keeps the field absent
      // (matches the typical timeline: budget collapse appears mid-run).
      latestDailyBudgetExhaustedBucketCount?: number;
      latestPlanStatus?: 'at_risk' | 'cannot_meet' | 'invalid' | 'on_track' | 'satisfied';
    }) => ({
      version: 1 as const,
      plansByDeviceId: {
        [params.deviceId]: {
          deviceId: params.deviceId,
          deviceName: 'Water Heater',
          objectiveKind: 'temperature' as const,
          targetTemperatureC: 65,
          targetPercent: null,
          deadlineAtMs: params.deadlineAtMs,
          startedAtMs: 0,
          pending: false,
          objectiveSignature: 'sig',
          ...(params.kwhPerUnit !== undefined ? {
            kwhPerUnitProvenance: {
              source: 'learned' as const,
              kWhPerUnit: params.kwhPerUnit,
              acceptedSamples: 8,
              confidence: 'medium' as const,
              lastAcceptedAtMs: 0,
            },
          } : {}),
          original: {
            revision: 1,
            revisedAtMs: 0,
            computedFromPricesUpTo: null,
            reason: 'flow_card' as const,
            hours: (params.originalHourStarts ?? [0]).map((startsAtMs) => ({ startsAtMs, plannedKWh: 1.0 })),
            energyNeededKWh: 2.0,
            planStatus: 'on_track' as const,
          },
          latest: {
            revision: params.latestRevision,
            revisedAtMs: params.latestRevisedAtMs,
            computedFromPricesUpTo: null,
            reason: params.latestReason ?? 'prices_revised' as const,
            hours: params.latestHourStarts.map((startsAtMs) => ({ startsAtMs, plannedKWh: 1.0 })),
            energyNeededKWh: 2.0,
            planStatus: params.latestPlanStatus ?? 'on_track' as const,
            ...(params.latestDailyBudgetExhaustedBucketCount !== undefined
              ? { dailyBudgetExhaustedBucketCount: params.latestDailyBudgetExhaustedBucketCount }
              : {}),
          },
        },
      },
    });

    it('drains the hourly progress ring into the entry at finalization', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      // Three cycles in distinct hours produce three samples; two cycles in
      // the same hour collapse to the most recent reading.
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 52 })], 30 * 60 * 1000);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 55 })], HOUR_MS);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 60 })], 2 * HOUR_MS);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.progressSamples).toBeDefined();
      // Three hour-buckets (0h / 1h / 2h). The half-hour sample upserts the
      // 0h bucket, so the persisted `atMs` for that bucket is the half-hour
      // timestamp (the latest observation kept) and not the bucket-start
      // timestamp — the UI gets the most precise time PELS actually saw the
      // reading.
      const sampleAtMs = entry.progressSamples!.map((s) => s.atMs);
      expect(sampleAtMs).toEqual([30 * 60 * 1000, HOUR_MS, 2 * HOUR_MS]);
      // Within 0h bucket: latest reading wins (52 °C, not the initial 50).
      expect(entry.progressSamples![0]!.valueC).toBe(52);
      expect(entry.progressSamples![1]!.valueC).toBe(55);
      expect(entry.progressSamples![2]!.valueC).toBe(60);
      // The temperature objective stamps `valuePercent: null` so the UI
      // never has to branch on objectiveKind to pick a field.
      for (const sample of entry.progressSamples!) {
        expect(sample.valuePercent).toBeNull();
      }
    });

    it('caps progressSamples at 48 entries, dropping the oldest', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      // A 60-hour deadline is unrealistic for production but exercises the cap.
      const deadlineAtMs = 60 * HOUR_MS;
      for (let hour = 0; hour < 55; hour += 1) {
        recorder.observe([makeDiag({
          deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 + hour,
        })], hour * HOUR_MS);
      }
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.progressSamples).toHaveLength(48);
      // Oldest 7 hours were dropped — first sample now starts at hour 7.
      expect(entry.progressSamples![0]!.atMs).toBe(7 * HOUR_MS);
      expect(entry.progressSamples![47]!.atMs).toBe(54 * HOUR_MS);
    });

    it('preserves the progress ring on abandon-grace finalization', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      // One sample before the diagnostic stops appearing.
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      // Abandon grace (ABANDON_GRACE_MS = 1h) elapses → run finalized as `abandoned`.
      recorder.observe([], 2 * HOUR_MS);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('abandoned');
      // The samples observed before the diagnostic stream stopped are still
      // drained into the entry so the history chart can show the partial run.
      expect(entry.progressSamples).toHaveLength(1);
      expect(entry.progressSamples![0]!.valueC).toBe(50);
    });

    it('ignores stale diagnostics so untrusted telemetry never lands in progressSamples', () => {
      // Regression: `buildProgressSample` previously persisted any non-null
      // `currentTemperatureC` / `currentPercent`, including readings whose
      // reason code says they are stale or otherwise untrustworthy. The
      // recorder now gates writes on `hasTrustworthyProgress` (same predicate
      // `finalProgress*` uses) so the history chart never disagrees with the
      // headline value the UI shows.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      // Cycle 1: fresh reading. Lands in the ring.
      recorder.observe([makeDiag({
        deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50,
      })], 0);
      // Cycle 2: same hour bucket as cycle 1, but the sensor has gone stale.
      // Must NOT overwrite the trusted 0 h sample with the untrusted value.
      recorder.observe([makeDiag({
        deviceId: 'dev', deadlineAtMs, currentTemperatureC: 99,
        reasonCode: 'objective_progress_stale',
      })], 30 * 60 * 1000);
      // Cycle 3: still stale on a new hour bucket. Must NOT add a new sample.
      recorder.observe([makeDiag({
        deviceId: 'dev', deadlineAtMs, currentTemperatureC: 99,
        reasonCode: 'objective_progress_stale',
      })], HOUR_MS);
      // Cycle 4: fresh again. Lands in the ring on hour 2.
      recorder.observe([makeDiag({
        deviceId: 'dev', deadlineAtMs, currentTemperatureC: 55,
      })], 2 * HOUR_MS);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.progressSamples).toHaveLength(2);
      // Hour-0 bucket kept the trusted 50 °C reading; the stale 99 °C upsert
      // was rejected even though it fell into the same bucket.
      expect(entry.progressSamples![0]!.atMs).toBe(0);
      expect(entry.progressSamples![0]!.valueC).toBe(50);
      // Hour-2 bucket has the next trusted reading. Hour-1 (stale-only) was
      // never written.
      expect(entry.progressSamples![1]!.atMs).toBe(2 * HOUR_MS);
      expect(entry.progressSamples![1]!.valueC).toBe(55);
    });

    it('records `deliveredKWh` and `totalCost` from hourly delivery contributions', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      // Start the run so an in-progress record exists for the contributions
      // to land on.
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      // Three priced hours: 1.0 kWh @ 0.50 + 1.5 kWh @ 0.80 + 0.5 kWh @ 1.20 = 3.0 kWh, 2.30 cost.
      recorder.recordHourlyDelivery({
        deviceId: 'dev', deadlineAtMs, hourStartMs: HOUR_MS, deliveredKWh: 1.0, priceValue: 0.50,
      });
      recorder.recordHourlyDelivery({
        deviceId: 'dev', deadlineAtMs, hourStartMs: 2 * HOUR_MS, deliveredKWh: 1.5, priceValue: 0.80,
      });
      recorder.recordHourlyDelivery({
        deviceId: 'dev', deadlineAtMs, hourStartMs: 3 * HOUR_MS, deliveredKWh: 0.5, priceValue: 1.20,
      });
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.deliveredKWh).toBeCloseTo(3.0);
      expect(entry.totalCost).toBeCloseTo(0.50 + 1.20 + 0.60);
    });

    it('persists `deliveredKWh: 0` on a real-but-zero contribution but suppresses both fields when no contribution arrived', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      // Run A receives a zero-kWh contribution at a negative price.
      // Both fields persist (the feed ran, the run is "this was free").
      recorder.observe([makeDiag({ deviceId: 'dev-a', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.recordHourlyDelivery({
        deviceId: 'dev-a', deadlineAtMs, hourStartMs: HOUR_MS, deliveredKWh: 0, priceValue: -0.10,
      });
      // Run B never receives a contribution. Both fields stay absent.
      recorder.observe([makeDiag({ deviceId: 'dev-b', deadlineAtMs, currentTemperatureC: 45 })], 0);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entriesByDeviceId = new Map(saved()!.entries.map((e) => [e.deviceId, e]));
      expect(entriesByDeviceId.get('dev-a')!.deliveredKWh).toBe(0);
      expect(entriesByDeviceId.get('dev-a')!.totalCost).toBe(0);
      expect(entriesByDeviceId.get('dev-b')!.deliveredKWh).toBeUndefined();
      expect(entriesByDeviceId.get('dev-b')!.totalCost).toBeUndefined();
    });

    it('ignores hourly delivery contributions for unknown runs (no in-progress record)', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      // No `observe` call — recorder has no in-progress record for this device.
      recorder.recordHourlyDelivery({
        deviceId: 'ghost', deadlineAtMs: HOUR_MS, hourStartMs: 0, deliveredKWh: 1.0, priceValue: 0.50,
      });
      // No persist should happen — recorder is clean.
      expect(recorder.isDirty()).toBe(false);
      expect(recorder.flushIfDirty()).toBe(false);
      expect(saved()).toBeNull();
    });

    it('drops negative or non-finite contributions defensively', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      // Negative kWh — dropped.
      recorder.recordHourlyDelivery({
        deviceId: 'dev', deadlineAtMs, hourStartMs: HOUR_MS, deliveredKWh: -1.0, priceValue: 0.50,
      });
      // NaN price — dropped.
      recorder.recordHourlyDelivery({
        deviceId: 'dev', deadlineAtMs, hourStartMs: HOUR_MS, deliveredKWh: 1.0, priceValue: Number.NaN,
      });
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      // Both contributions dropped → no delivery contribution recorded → fields absent.
      expect(entry.deliveredKWh).toBeUndefined();
      expect(entry.totalCost).toBeUndefined();
    });

    it('captures `kwhPerUnitMean` from the active plan onto the revision snapshots', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const plans = buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 2,
        latestRevisedAtMs: HOUR_MS,
        latestHourStarts: [HOUR_MS, 2 * HOUR_MS],
        originalHourStarts: [HOUR_MS],
        kwhPerUnit: 0.59,
      });
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0, plans);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.originalPlan?.kwhPerUnitMean).toBeCloseTo(0.59);
      expect(entry.finalPlan?.kwhPerUnitMean).toBeCloseTo(0.59);
    });

    it('omits `kwhPerUnitMean` when the active plan has no provenance snapshot', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const plans = buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 1,
        latestRevisedAtMs: 0,
        latestHourStarts: [HOUR_MS],
        // No kwhPerUnit passed → no provenance on the plan.
      });
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0, plans);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.originalPlan?.kwhPerUnitMean).toBeUndefined();
      expect(entry.finalPlan?.kwhPerUnitMean).toBeUndefined();
    });

    // v2.7.2 PR 3 capture: `dailyBudgetExhaustedBucketCount` on the latest
    // revision flows onto the persisted snapshot so the history postmortem
    // can distinguish missed-by-budget-exhaustion from a plain shortfall.
    it('captures `dailyBudgetExhaustedBucketCount` on the final snapshot when the revision had budget collapse', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const plans = buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 2,
        latestRevisedAtMs: HOUR_MS,
        latestHourStarts: [HOUR_MS, 2 * HOUR_MS],
        originalHourStarts: [HOUR_MS],
        kwhPerUnit: 0.59,
        latestPlanStatus: 'cannot_meet',
        latestDailyBudgetExhaustedBucketCount: 4,
      });
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0, plans);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.finalPlan?.dailyBudgetExhaustedBucketCount).toBe(4);
    });

    it('omits `dailyBudgetExhaustedBucketCount` when the revision reports zero buckets', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const plans = buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 1,
        latestRevisedAtMs: 0,
        latestHourStarts: [HOUR_MS],
        latestDailyBudgetExhaustedBucketCount: 0,
      });
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0, plans);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      // Zero is meaningful on the runtime field, but the snapshot suppresses
      // it so legacy v3 entries stay byte-stable on round-trip and the
      // consumer's "treat absence as zero" rule keeps working.
      expect(entry.finalPlan?.dailyBudgetExhaustedBucketCount).toBeUndefined();
    });

    it('appends a revision-log entry per replan with reason + +/- hour counts', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 8 * HOUR_MS;
      // Cycle 1: revision 1, hours = [0h].
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0, buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 1,
        latestRevisedAtMs: 0,
        latestHourStarts: [0],
        originalHourStarts: [0],
        kwhPerUnit: 0.5,
      }));
      // Cycle 2: revision 2 (prices_revised), hours = [0h, 1h, 2h] → +2 hours.
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 52 })], HOUR_MS, buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 2,
        latestRevisedAtMs: HOUR_MS,
        latestReason: 'prices_revised',
        latestHourStarts: [0, HOUR_MS, 2 * HOUR_MS],
        originalHourStarts: [0],
        kwhPerUnit: 0.5,
      }));
      // Cycle 3: revision 3 (rate_refined), hours = [HOUR_MS, 2h] → -1 hour (0h removed).
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 55 })], 2 * HOUR_MS, buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 3,
        latestRevisedAtMs: 2 * HOUR_MS,
        latestReason: 'rate_refined',
        latestHourStarts: [HOUR_MS, 2 * HOUR_MS],
        originalHourStarts: [0],
        kwhPerUnit: 0.5,
      }));
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.revisions).toHaveLength(2);
      expect(entry.revisions![0]!.atMs).toBe(HOUR_MS);
      expect(entry.revisions![0]!.reasonId).toBe('prices_revised');
      expect(entry.revisions![0]!.hoursAdded).toBe(2);
      expect(entry.revisions![0]!.hoursRemoved).toBe(0);
      expect(entry.revisions![1]!.atMs).toBe(2 * HOUR_MS);
      expect(entry.revisions![1]!.reasonId).toBe('rate_refined');
      expect(entry.revisions![1]!.hoursAdded).toBe(0);
      expect(entry.revisions![1]!.hoursRemoved).toBe(1);
    });

    it('does not log a phantom revision entry when the recorder picks up mid-run at revision ≥ 2', () => {
      // Regression: when `startRecord` seeds `finalPlan` with an already-
      // replanned revision (e.g. PELS restarts mid-run with `latest.revision = 2`),
      // the next `refreshPlanSnapshots` cycle would previously append a
      // phantom `+0/-0` revision-log entry comparing `rev2` against itself.
      // The recorder can't honestly count replans it didn't witness, so it
      // must skip the log when `previousFinalPlan.revisedAtMs` already
      // matches the next revision's timestamp.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const plans = buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 2,
        latestRevisedAtMs: HOUR_MS,
        latestHourStarts: [HOUR_MS],
        originalHourStarts: [0],
        kwhPerUnit: 0.5,
      });
      // Three consecutive cycles with the same already-replanned revision —
      // no real replan transition occurs during the recorder's lifetime, so
      // nothing should land on `revisions[]`.
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0, plans);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 51 })], HOUR_MS, plans);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 52 })], 2 * HOUR_MS, plans);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.revisions).toBeUndefined();
    });

    it('omits `revisions[]` entirely when the run never replanned past the seed revision', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const plans = buildActivePlansV4({
        deviceId: 'dev',
        deadlineAtMs,
        latestRevision: 1, // never replanned
        latestRevisedAtMs: 0,
        latestHourStarts: [0],
        kwhPerUnit: 0.5,
      });
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0, plans);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      expect(saved()!.entries[0]!.revisions).toBeUndefined();
    });
  });
});
