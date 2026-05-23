import {
  DeferredObjectivePlanHistoryRecorder,
  type PlanHistoryPersistDeps,
} from '../lib/plan/deferredObjectives/planHistory';
import { buildFinalHourFlush } from '../lib/plan/deferredObjectives/planHistoryV4Helpers';
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
        deviceId: 'dev', deadlineAtMs, hourStartMs: HOUR_MS, deliveredKWh: 1.0, priceValue: 0.50, tone: 'cheap',
      });
      recorder.recordHourlyDelivery({
        deviceId: 'dev', deadlineAtMs, hourStartMs: 2 * HOUR_MS, deliveredKWh: 1.5, priceValue: 0.80, tone: 'normal',
      });
      recorder.recordHourlyDelivery({
        deviceId: 'dev', deadlineAtMs, hourStartMs: 3 * HOUR_MS, deliveredKWh: 0.5, priceValue: 1.20, tone: 'expensive',
      });
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.deliveredKWh).toBeCloseTo(3.0);
      expect(entry.totalCost).toBeCloseTo(0.50 + 1.20 + 0.60);
      // Each contribution lands on its own per-hour bucket so the postmortem
      // bar strip (v2.7.3) reads one bar per delivered hour. Totals still
      // match the sum, but the per-hour rows preserve the tone/price the
      // caller resolved at contribution time.
      expect(entry.hourlyContributions).toHaveLength(3);
      expect(entry.hourlyContributions![0]).toEqual({
        atMs: HOUR_MS, deliveredKWh: 1.0, priceValue: 0.50, tone: 'cheap',
      });
      expect(entry.hourlyContributions![1]).toEqual({
        atMs: 2 * HOUR_MS, deliveredKWh: 1.5, priceValue: 0.80, tone: 'normal',
      });
      expect(entry.hourlyContributions![2]).toEqual({
        atMs: 3 * HOUR_MS, deliveredKWh: 0.5, priceValue: 1.20, tone: 'expensive',
      });
    });

    it('merges duplicate hourly contributions onto a single bucket and suppresses the field when no contribution arrived', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      // Two contributions for the same hour (aggregator replay): kWh summed,
      // the fresher tone/price wins. Mid-hour `hourStartMs` floors to the
      // hour boundary so the postmortem reads a stable axis.
      recorder.observe([makeDiag({ deviceId: 'dev-a', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.recordHourlyDelivery({
        deviceId: 'dev-a', deadlineAtMs, hourStartMs: HOUR_MS + 15 * 60_000, deliveredKWh: 0.4, priceValue: 0.30, tone: 'cheap',
      });
      recorder.recordHourlyDelivery({
        deviceId: 'dev-a', deadlineAtMs, hourStartMs: HOUR_MS + 45 * 60_000, deliveredKWh: 0.6, priceValue: 0.40, tone: 'normal',
      });
      // Run B never receives a contribution → `hourlyContributions` stays
      // absent, mirroring the existing `deliveredKWh` suppression contract.
      recorder.observe([makeDiag({ deviceId: 'dev-b', deadlineAtMs, currentTemperatureC: 45 })], 0);
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entriesByDeviceId = new Map(saved()!.entries.map((e) => [e.deviceId, e]));
      const merged = entriesByDeviceId.get('dev-a')!;
      expect(merged.hourlyContributions).toHaveLength(1);
      expect(merged.hourlyContributions![0]).toEqual({
        atMs: HOUR_MS, deliveredKWh: 1.0, priceValue: 0.40, tone: 'normal',
      });
      expect(entriesByDeviceId.get('dev-b')!.hourlyContributions).toBeUndefined();
    });

    it('persists `deliveredKWh: 0` on a real-but-zero contribution but suppresses both fields when no contribution arrived', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      // Run A receives a zero-kWh contribution at a negative price.
      // Both fields persist (the feed ran, the run is "this was free").
      recorder.observe([makeDiag({ deviceId: 'dev-a', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.recordHourlyDelivery({
        deviceId: 'dev-a', deadlineAtMs, hourStartMs: HOUR_MS, deliveredKWh: 0, priceValue: -0.10, tone: 'cheap',
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
        deviceId: 'ghost', deadlineAtMs: HOUR_MS, hourStartMs: 0, deliveredKWh: 1.0, priceValue: 0.50, tone: 'normal',
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
        deviceId: 'dev', deadlineAtMs, hourStartMs: HOUR_MS, deliveredKWh: -1.0, priceValue: 0.50, tone: 'normal',
      });
      // NaN price — dropped.
      recorder.recordHourlyDelivery({
        deviceId: 'dev', deadlineAtMs, hourStartMs: HOUR_MS, deliveredKWh: 1.0, priceValue: Number.NaN, tone: 'normal',
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

  describe('internal hour-rollover delivery wiring', () => {
    // Regression target: v2.7.2 shipped the recorder API + history v4
    // schema but no production caller invoked `recordHourlyDelivery`, so
    // every real entry persisted with `hasDeliveryContribution: false`
    // and the postmortem strip / cost narrative chip were dark. The
    // recorder now drives contributions itself from the observe loop
    // using the diagnostic's progress delta and an injected hourly
    // price+tone resolver — these tests assert wired entries populate
    // the v4 delivery fields end-to-end.

    const buildPersistDepsWithPrice = (
      pricesByHourMs: Record<number, { priceValue: number; tone: 'cheap' | 'normal' | 'expensive' }>,
    ) => {
      const inner = buildPersistDeps();
      return {
        deps: {
          ...inner.deps,
          resolveHourPrice: (hourStartMs: number) => pricesByHourMs[hourStartMs] ?? null,
        },
        saved: inner.saved,
      };
    };

    it('emits a contribution for the just-closed hour on each observed hour rollover', () => {
      const { deps, saved } = buildPersistDepsWithPrice({
        [HOUR_MS]: { priceValue: 0.5, tone: 'cheap' },
        [2 * HOUR_MS]: { priceValue: 0.8, tone: 'normal' },
      });
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 5 * HOUR_MS;
      // Three cycles, one per hour bucket. Δtemp 50→52 in hour 1, 52→55 in hour 2.
      // kWh/°C = 1.5 → 3.0 kWh in hour 1, 4.5 kWh in hour 2.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })],
        HOUR_MS + 5 * 60_000,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 52 })],
        2 * HOUR_MS + 5 * 60_000,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 55 })],
        3 * HOUR_MS + 5 * 60_000,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.hourlyContributions).toBeDefined();
      // Hour 1 (opening 50, closing 52 → 3.0 kWh @ 0.5) + Hour 2 (opening 52,
      // closing 55 → 4.5 kWh @ 0.8). The currently-open hour (3) flushes at
      // finalize using `finalProgress`, but Δ is 0 since the third observe
      // was the run's last reading, so only hours 1 and 2 land.
      expect(entry.hourlyContributions).toHaveLength(2);
      expect(entry.hourlyContributions![0]).toEqual({
        atMs: HOUR_MS,
        deliveredKWh: 3.0,
        priceValue: 0.5,
        tone: 'cheap',
      });
      expect(entry.hourlyContributions![1]).toEqual({
        atMs: 2 * HOUR_MS,
        deliveredKWh: 4.5,
        priceValue: 0.8,
        tone: 'normal',
      });
      expect(entry.deliveredKWh).toBeCloseTo(7.5);
      expect(entry.totalCost).toBeCloseTo(3.0 * 0.5 + 4.5 * 0.8);
    });

    it('flushes the still-open hour at finalize so sub-hour runs persist their delivery', () => {
      const { deps, saved } = buildPersistDepsWithPrice({
        [HOUR_MS]: { priceValue: 1.0, tone: 'expensive' },
      });
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = HOUR_MS + 30 * 60_000;
      // Two observations inside the same hour — never crosses a boundary.
      // 50 → 51 °C in the hour, kWh/°C = 1.5 → 1.5 kWh delivered.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })],
        HOUR_MS + 5 * 60_000,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 51 })],
        HOUR_MS + 20 * 60_000,
      );
      // Deadline passes → finalize.
      recorder.observe([], deadlineAtMs + 1);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.hourlyContributions).toHaveLength(1);
      expect(entry.hourlyContributions![0]).toEqual({
        atMs: HOUR_MS,
        deliveredKWh: 1.5,
        priceValue: 1.0,
        tone: 'expensive',
      });
      expect(entry.deliveredKWh).toBeCloseTo(1.5);
      expect(entry.totalCost).toBeCloseTo(1.5);
    });

    it('skips emission when the resolver returns no price for the closed hour', () => {
      // No price registered → resolver returns null → no contribution.
      const { deps, saved } = buildPersistDepsWithPrice({});
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 3 * HOUR_MS;
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })],
        HOUR_MS + 5 * 60_000,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 53 })],
        2 * HOUR_MS + 5 * 60_000,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      // No price for the closed hour → no contribution → fields absent.
      expect(entry.hourlyContributions).toBeUndefined();
      expect(entry.deliveredKWh).toBeUndefined();
      expect(entry.totalCost).toBeUndefined();
    });

    it('skips emission when no kWh-per-unit factor has resolved yet', () => {
      const { deps, saved } = buildPersistDepsWithPrice({
        [HOUR_MS]: { priceValue: 0.5, tone: 'cheap' },
      });
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 3 * HOUR_MS;
      // `kWhPerDegreeC: null` → cold start before any profile (learned or
      // bootstrap) resolved. We can still anchor the opening progress, but
      // there's nothing to multiply against, so no contribution lands.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50, kWhPerDegreeC: null })],
        HOUR_MS + 5 * 60_000,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 53, kWhPerDegreeC: null })],
        2 * HOUR_MS + 5 * 60_000,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.hourlyContributions).toBeUndefined();
      expect(entry.deliveredKWh).toBeUndefined();
    });

    it('restarts mid-run drop the in-flight hour anchor (lossy-restart contract)', () => {
      // Pins the documented behaviour: `currentHourOpening` /
      // `lastKWhPerUnit` live only in memory. A PELS restart mid-run
      // re-seeds the opening at the first post-restart reading, so any
      // delivery between the pre-restart anchor and the first post-restart
      // observation is lost from the postmortem strip. The contribution
      // lands on the *post-restart* hour anchor, not the original one.
      // See `InProgressRecord.currentHourOpening` docstring for the
      // follow-up plan to persist these fields.
      const pricesByHourMs: Record<number, { priceValue: number; tone: 'cheap' | 'normal' | 'expensive' }> = {
        [HOUR_MS]: { priceValue: 0.5, tone: 'cheap' },
        [2 * HOUR_MS]: { priceValue: 0.8, tone: 'normal' },
      };
      const persisted = buildPersistDepsWithPrice(pricesByHourMs);
      const deadlineAtMs = 5 * HOUR_MS;

      // First "PELS process": anchor at 50 °C in hour 1.
      const recorderA = new DeferredObjectivePlanHistoryRecorder(persisted.deps);
      recorderA.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })],
        HOUR_MS + 5 * 60_000,
      );
      // Process dies here. No flush of in-progress map; persisted entries
      // (none yet) survive.

      // Second "PELS process": fresh recorder against the same persistence.
      // The first reading after restart is 53 °C still inside hour 1.
      // Without persisted opening, the recorder re-anchors at 53.
      const recorderB = new DeferredObjectivePlanHistoryRecorder(persisted.deps);
      recorderB.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 53 })],
        HOUR_MS + 40 * 60_000,
      );
      // Cross into hour 2 with 55 °C. Delta from post-restart opening
      // (53 → 55) attributes 2 °C × 1.5 kWh/°C = 3.0 kWh to hour 1.
      // The 50 → 53 °C delivered before the restart is lost.
      recorderB.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 55 })],
        2 * HOUR_MS + 5 * 60_000,
      );
      recorderB.observe([], deadlineAtMs);
      recorderB.flushIfDirty();

      const entry = persisted.saved()!.entries[0]!;
      expect(entry.hourlyContributions).toHaveLength(1);
      expect(entry.hourlyContributions![0]).toEqual({
        atMs: HOUR_MS,
        deliveredKWh: 3.0, // post-restart delta only, not the 50→55 full delta (which would be 7.5)
        priceValue: 0.5,
        tone: 'cheap',
      });
      expect(entry.deliveredKWh).toBeCloseTo(3.0);
    });

    it('finalize-time flush advances the opening anchor to the next hour bucket', () => {
      // Regression: `flushOpenHourAtFinalize` historically returned the
      // just-closed `hourMs` as the new `nextOpening.hourMs`. Today the
      // recorder deletes the in-progress record immediately after flushing, so
      // the stale anchor never surfaces — but a future refactor that observes
      // the returned record (e.g. one more rollover detection pass before
      // delete) would re-attribute progress against the just-flushed hour and
      // double-count. Pin the next-bucket shape directly on the pure helper so
      // the contract is enforced regardless of caller discipline.
      const opening = { hourMs: HOUR_MS, value: 50 };
      const flush = buildFinalHourFlush({
        opening,
        finalProgress: 51,
        kWhPerUnit: 1.5,
        resolvePrice: (hourStartMs) => (hourStartMs === HOUR_MS
          ? { priceValue: 1.0, tone: 'expensive' }
          : null),
      });
      expect(flush).not.toBeNull();
      expect(flush!.contribution).toEqual({
        atMs: HOUR_MS,
        deliveredKWh: 1.5,
        priceValue: 1.0,
        tone: 'expensive',
      });
      // The fix: nextOpening points to the NEXT hour bucket, not the
      // just-flushed one. The pre-fix value would have been `HOUR_MS` (the
      // same bucket as `opening.hourMs`).
      expect(flush!.nextOpening.hourMs).toBe(2 * HOUR_MS);
      expect(flush!.nextOpening.hourMs).not.toBe(opening.hourMs);
      expect(flush!.nextOpening.value).toBe(51);
    });

    it('finalize-time flush returns null when there is no opening anchor', () => {
      // Cold start / no anchor: flush is a no-op. Matches
      // `buildFinalHourContribution`'s null-on-no-anchor contract so the
      // recorder's `flushOpenHourAtFinalize` wrapper short-circuits.
      const flush = buildFinalHourFlush({
        opening: null,
        finalProgress: 51,
        kWhPerUnit: 1.5,
        resolvePrice: () => ({ priceValue: 1.0, tone: 'expensive' }),
      });
      expect(flush).toBeNull();
    });
  });

  describe('stall promotion (`metReason: "stalled"`)', () => {
    // Regression target: production Connected 300 run 7791d6c5 — the tank
    // plateaued at ~61.8 °C against a 65 °C target after ~10 h. The horizon
    // planner kept reporting `on_track` / `cannot_meet` instead of
    // `satisfied`, so the existing path classified the run as `missed`.
    // With the idle-classifier bridge in place, the recorder accepts the
    // device's "as warm as it'll hold" plateau as a success.
    it('promotes a non-satisfied run to met when the classifier reports near_target_idle', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const stallNearTarget = () => 'near_target_idle' as const;

      // Run starts cold; classifier hasn't fired yet.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 60.9 })],
        0,
      );
      // 3 hours in: device has plateaued near setpoint; the classifier
      // reports `near_target_idle`. The horizon planner still says
      // `on_track` because (target − current) > 0.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 61.8 })],
        3 * HOUR_MS,
        null,
        stallNearTarget,
      );
      // 5 hours in: tank drifts down a bit (post-stall cooling). Without
      // the freeze, `finalProgressC` would track this drift; with the
      // freeze it should stay at 61.8.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 60.4 })],
        5 * HOUR_MS,
        null,
        stallNearTarget,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBe('stalled');
      expect(entry.metAtMs).toBe(3 * HOUR_MS);
      expect(entry.finalProgressC).toBeCloseTo(61.8, 1);
    });

    it('does not write metReason on runs that crossed the target normally', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })], 0);
      recorder.observe(
        [makeDiag({
          deviceId: 'dev',
          deadlineAtMs,
          currentTemperatureC: 66,
          status: 'satisfied',
          horizonPlan: makeHorizon({ status: 'satisfied', statusDetail: 'energy_already_met' }),
        })],
        3 * HOUR_MS,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBeUndefined();
    });

    it('ignores `unresponsive` — only the stall classifications trigger stall met', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const stuckUnresponsive = () => 'unresponsive' as const;

      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 20 })],
        0,
        null,
        stuckUnresponsive,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 20 })],
        3 * HOUR_MS,
        null,
        stuckUnresponsive,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('missed');
      expect(entry.metReason).toBeUndefined();
    });

    it('promotes to met/stalled_device_capped when classifier reports capped_idle', () => {
      // Connected 300 capped-internally scenario: device parks at 58 °C
      // against a 65 °C target with power cycling around its own
      // thermostat hysteresis. The cycling reset means the existing
      // `near_target_idle` path can never fire (the streak resets every
      // on-cycle), and the gap > 5 °C is outside the near-target band
      // anyway. With `capped_idle` wired in, the run finalises as
      // succeeded — same outcome as `near_target_idle` but a distinct
      // `metReason` so the postmortem can name the device's own setpoint
      // cap rather than the generic stalled copy.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const cappedIdle = () => 'capped_idle' as const;

      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 58 })],
        0,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 58 })],
        3 * HOUR_MS,
        null,
        cappedIdle,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBe('stalled_device_capped');
      expect(entry.metAtMs).toBe(3 * HOUR_MS);
      expect(entry.finalProgressC).toBeCloseTo(58, 1);
    });

    it('keeps the capped-idle promotion sticky across later non-plannable ticks', () => {
      // Mirrors the `near_target_idle` stickiness — the device having
      // accepted the run against its own cap is terminal even if the
      // tank drifts down a degree afterwards. Without this, the next
      // plannable tick would re-open the run because the diag still says
      // `on_track` while progress is below target.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const cappedIdle = () => 'capped_idle' as const;
      const noClassifier = () => undefined;

      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 58 })],
        HOUR_MS,
        null,
        cappedIdle,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 58 })],
        2 * HOUR_MS,
        null,
        cappedIdle,
      );
      // Classifier exits capped_idle (e.g. user lowered PELS target);
      // the already-promoted record must not retract.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 55 })],
        4 * HOUR_MS,
        null,
        noClassifier,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBe('stalled_device_capped');
      expect(entry.finalProgressC).toBeCloseTo(58, 1);
    });

    it('keeps the stall promotion sticky across subsequent plannable ticks reporting below-target progress', () => {
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const stallNearTarget = () => 'near_target_idle' as const;
      const noClassifier = () => undefined;

      // First tick: brand-new record. The carryover guard skips promotion
      // here regardless of classifier state.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 61.8 })],
        HOUR_MS,
        null,
        stallNearTarget,
      );
      // Second tick: existing record, classifier still reports
      // near_target_idle → promotion fires here.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 61.8 })],
        2 * HOUR_MS,
        null,
        stallNearTarget,
      );
      // Classifier subsequently exits idle (tank cooled below the
      // hysteresis exit threshold) — the recorder must NOT downgrade the
      // already-stalled record; the device having accepted the run as
      // done is not retracted by later drift.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 55 })],
        4 * HOUR_MS,
        null,
        noClassifier,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBe('stalled');
      expect(entry.finalProgressC).toBeCloseTo(61.8, 1);
    });

    it('skips stall promotion on the first tick of a new record — stale classification carryover guard', () => {
      // Regression for PR #888 review (chatgpt-codex-connector): the
      // classifier ticks AFTER plan emission, so the result the recorder
      // reads on the cycle a record is first seen belongs to whatever
      // objective ran for this device on the previous tick. After a
      // `finalizeForUserChange` swap, that stale `near_target_idle` must
      // not auto-complete the brand-new run on tick 1. The next tick —
      // where the classifier has re-evaluated against the current
      // objective — handles promotion through the existing-record path.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const stallNearTarget = () => 'near_target_idle' as const;

      // Brand-new record — classifier already says near_target_idle from
      // the *previous* run's plateau. The recorder must not promote here.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })],
        0,
        null,
        stallNearTarget,
      );
      // Subsequent tick: classification is fresh and authoritative.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 51 })],
        HOUR_MS,
        null,
        stallNearTarget,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBe('stalled');
      // Promotion lands on the second tick, not the first.
      expect(entry.metAtMs).toBe(HOUR_MS);
    });

    it('captures the live diagnostic reading into finalProgress at promotion time even on a non-plannable tick', () => {
      // Regression for PR #888 review (Copilot): when stall fires via a
      // non-plannable tick (e.g. status='unknown' carrying a trustworthy
      // currentTemperatureC), `recordObservedTick` doesn't refresh
      // `finalProgress*`, so without an explicit capture in
      // `promoteRecordToStalled` the freeze would pin to the previous
      // plannable tick's reading rather than the live plateau. The
      // chart marker and the postmortem caption would then both read
      // the stale value.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const stallNearTarget = () => 'near_target_idle' as const;
      const unknown = (): DeferredObjectiveDiagnostic['status'] => 'unknown';

      // First tick: brand-new record at 50 °C — first-tick gate skips
      // promotion. `mergeRecord` runs (status='on_track' plannable).
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })],
        0,
      );
      // Second tick: classifier says near_target_idle, but the diag
      // arrives with status='unknown' (non-plannable). The live reading
      // is 61.8 °C — that is the value the stalled entry must freeze.
      recorder.observe(
        [makeDiag({
          deviceId: 'dev',
          deadlineAtMs,
          currentTemperatureC: 61.8,
          status: unknown(),
          // `objective_missing_charge_rate` is a non-plannable reason
          // outside the untrustworthy set — the diag carries a real
          // temperature reading, so `hasTrustworthyProgress` should let
          // promotion capture it.
          reasonCode: 'objective_missing_charge_rate',
          horizonPlan: undefined,
        })],
        HOUR_MS,
        null,
        stallNearTarget,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBe('stalled');
      // The promotion captured the live plateau reading, not the prior
      // plannable tick's 50 °C value.
      expect(entry.finalProgressC).toBeCloseTo(61.8, 1);
    });

    it('does not promote when only the first tick fires near_target_idle (no subsequent ticks)', () => {
      // Locks in the producer-side gate: if a brand-new run sees a stale
      // `near_target_idle` on its only cycle and the deadline immediately
      // elapses, the entry must finalize as `missed` rather than silently
      // met by carryover.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const stallNearTarget = () => 'near_target_idle' as const;

      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50 })],
        0,
        null,
        stallNearTarget,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('missed');
      expect(entry.metReason).toBeUndefined();
    });

    it('a stalled run replaced by the user before its deadline still finalizes as met (stall promotion is terminal)', () => {
      // `classifyOutcome` returns `'met'` whenever the in-progress record
      // is satisfied, regardless of the finalize reason — so once stall
      // has fired, a subsequent user-replace doesn't downgrade the
      // outcome. The metReason rides through. The contract validator's
      // "metReason only on met" guard is a defensive read-time check for
      // hand-edited / corrupted persisted payloads; the recorder itself
      // never produces the violating combination.
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      const stallNearTarget = () => 'near_target_idle' as const;

      // Two ticks to clear the first-tick carryover guard; promotion lands
      // on the second tick.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 61.8 })],
        HOUR_MS,
        null,
        stallNearTarget,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 61.8 })],
        2 * HOUR_MS,
        null,
        stallNearTarget,
      );
      recorder.finalizeForUserChange('dev', 3 * HOUR_MS, 'replaced');
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBe('stalled');
    });

    it('Connected 300 capped-internally end-to-end: classifier-driven capped_idle promotes to succeeded', async () => {
      // Full reproducer of the TODO bug: Connected 300 capped internally
      // at ~60 °C with a 65 °C smart-task target. The classifier
      // observes a cycling+stable-temp+gap-too-big pattern over the
      // window and reports `capped_idle`; the recorder's
      // getStallClassification bridge promotes the run to
      // met/stalled_device_capped instead of finalising it as missed.
      const { createIdleClassifier } = await import('../lib/observer/idleClassifier');
      const { CAPPED_IDLE_MIN_WINDOW_MS } = await import('../lib/observer/idleDetector');

      const classifier = createIdleClassifier();
      const { deps, saved } = buildPersistDeps();
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;

      // Drive the classifier with cycling+stable-temp ticks across the
      // 20-min window so it transitions to `capped_idle`. Tank parked
      // at 58 °C (7 °C gap from the 65 °C target).
      const tickMs = 30_000;
      let cursor = 0;
      let drawing = true;
      while (cursor <= CAPPED_IDLE_MIN_WINDOW_MS) {
        classifier.classifyAll([{
          id: 'dev',
          name: 'Connected 300',
          currentState: 'on',
          currentOn: true,
          observationStale: false,
          measuredPowerKw: drawing ? 1.2 : 0,
          currentTemperature: 58,
          currentTarget: 65,
          shedAction: undefined,
          controlCapabilityId: 'onoff',
        }], cursor);
        cursor += tickMs;
        drawing = !drawing;
      }
      expect(classifier.getClassification('dev')).toBe('capped_idle');

      // Recorder observes a few cycles before stall promotion. First
      // observation seeds the in-progress record (without a classifier
      // — the first-tick carryover guard skips stall promotion on
      // the very first cycle). Subsequent observations pass through the
      // classifier and trigger the capped_idle promotion.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 58 })],
        0,
      );
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 58 })],
        CAPPED_IDLE_MIN_WINDOW_MS + tickMs,
        null,
        (deviceId) => classifier.getClassification(deviceId),
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();

      const entry = saved()!.entries[0]!;
      // Run finalises as succeeded — not the buggy "missed" verdict the
      // TODO entry describes. The metReason names the device cap so
      // the postmortem can route to the correct recourse copy.
      expect(entry.outcome).toBe('met');
      expect(entry.metReason).toBe('stalled_device_capped');
      expect(entry.finalProgressC).toBeCloseTo(58, 1);
    });
  });

  describe('miss attribution (plan-time provenance + structured log)', () => {
    // Active plan carrying the provenance the attribution rests on: a
    // low-confidence learned rate over few accepted samples, plus the
    // committed full-hour floor power.
    const buildProvenancedPlans = (params: {
      deviceId: string;
      deadlineAtMs: number;
      confidence?: 'low' | 'medium' | 'high' | null;
      acceptedSamples?: number;
      planningSpeedKw?: number;
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
          ...(params.planningSpeedKw !== undefined
            ? { initialPlanningSpeedKw: params.planningSpeedKw }
            : {}),
          kwhPerUnitProvenance: {
            source: 'learned' as const,
            kWhPerUnit: 1.5,
            acceptedSamples: params.acceptedSamples ?? 3,
            confidence: params.confidence ?? 'low',
            lastAcceptedAtMs: 0,
          },
          original: {
            revision: 1,
            revisedAtMs: 0,
            computedFromPricesUpTo: null,
            reason: 'flow_card' as const,
            hours: [{ startsAtMs: 0, plannedKWh: 2.0 }],
            energyNeededKWh: 2.0,
            planStatus: 'cannot_meet' as const,
          },
          latest: {
            revision: 1,
            revisedAtMs: 0,
            computedFromPricesUpTo: null,
            reason: 'flow_card' as const,
            hours: [{ startsAtMs: 0, plannedKWh: 2.0 }],
            energyNeededKWh: 2.0,
            planStatus: 'cannot_meet' as const,
          },
        },
      },
    });

    const driveMissedRun = (deps: PlanHistoryPersistDeps, plans: ReturnType<typeof buildProvenancedPlans>) => {
      const recorder = new DeferredObjectivePlanHistoryRecorder(deps);
      const deadlineAtMs = 6 * HOUR_MS;
      // Observed below target throughout, then swept at the deadline → missed.
      recorder.observe(
        [makeDiag({ deviceId: 'dev', deadlineAtMs, currentTemperatureC: 50, status: 'cannot_meet' })],
        0,
        plans,
      );
      recorder.observe([], deadlineAtMs);
      recorder.flushIfDirty();
      return recorder;
    };

    it('captures plan-time confidence, accepted samples, and the committed floor onto the snapshot', () => {
      const { deps, saved } = buildPersistDeps();
      driveMissedRun(deps, buildProvenancedPlans({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        confidence: 'low',
        acceptedSamples: 3,
        planningSpeedKw: 3.2,
      }));
      const snapshot = saved()!.entries[0]!.finalPlan!;
      expect(snapshot.rateConfidence).toBe('low');
      expect(snapshot.acceptedSamples).toBe(3);
      expect(snapshot.planningSpeedKw).toBeCloseTo(3.2);
    });

    it('emits a finalized attribution event with the resolved miss cause', () => {
      const events: Record<string, unknown>[] = [];
      const { deps } = buildPersistDeps();
      driveMissedRun(
        { ...deps, debugStructured: (payload) => { events.push(payload); } },
        buildProvenancedPlans({
          deviceId: 'dev',
          deadlineAtMs: 6 * HOUR_MS,
          confidence: 'low',
          acceptedSamples: 3,
        }),
      );
      const finalized = events.find((e) => e.event === 'deferred_objective_history_finalized');
      expect(finalized).toMatchObject({
        outcome: 'missed',
        missCause: 'low_confidence',
        rateConfidence: 'low',
        acceptedSamples: 3,
      });
    });
  });
});
