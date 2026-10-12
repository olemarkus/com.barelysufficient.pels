import { describe, expect, it, vi } from 'vitest';
import {
  PowerCalibrationStore,
  createPowerCalibrationRepository,
  importLegacyPowerCalibration,
} from '../../lib/device/devicePowerCalibrationStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import type {
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { captureLogger } from '../utils/loggerCapture';
import { POWER_CALIBRATION } from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

const CONNECTED_300_PROFILE: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const baseDeviceSnapshot = (
  overrides: Partial<
    TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
  > = {},
): TargetDeviceSnapshot & MeasuredPowerObservedProbe
  & SteppedLoadDescriptorProbe & ReportedStepObservedProbe => ({
  id: 'hoiax-1',
  name: 'Hoiax',
  targets: [],
  controlModel: 'stepped_load',
  steppedLoadProfile: CONNECTED_300_PROFILE,
  reportedStepId: 'max',
  measuredPowerKw: 2.75,
  binaryControl: { on: true },
  lastFreshDataMs: 0,
  ...overrides,
}) as TargetDeviceSnapshot;

const memoryStore = (db: UserdataDatabase = openUserdataDatabase(IN_MEMORY_DATABASE)): PowerCalibrationStore => (
  new PowerCalibrationStore(createPowerCalibrationRepository(db))
);

const rowCount = (db: UserdataDatabase): number => (
  (db.prepare('SELECT COUNT(*) AS n FROM power_calibration_devices').get() as { n: number }).n
);
const totalChanges = (db: UserdataDatabase): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

const step = (observedKw: number, nameplateAtSampleKw: number, lastSampleMs = 1_000): Record<string, unknown> => ({
  observedKw,
  nameplateAtSampleKw,
  samples: 100,
  sustainedSeconds: 6_000,
  lastSampleMs,
});

describe('PowerCalibrationStore.ingestDeviceSnapshot', () => {
  it('records a sample for a confirmed stepped-load snapshot', () => {
    const store = memoryStore();
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 0 }), 0);
    expect(outcome?.accepted).toBe(true);
    expect(store.getSnapshot().devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
  });

  it('returns null when there is no reported step (assumed-step fallback only)', () => {
    // Sampling on an assumed step would attribute measured power to a step the
    // device may never have visited. The producer only sets `reportedStepId`
    // from real native/flow telemetry, so its absence is the eligibility gate.
    const store = memoryStore();
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({ reportedStepId: undefined }), 0);
    expect(outcome).toBeNull();
  });

  // The former `stepCommandPending` ingest guard was removed in the snapshot
  // decomposition: `stepCommandPending` is app-layer decoration the raw
  // `getSnapshot()` ingest path never carried, so the guard was an
  // always-false no-op in production. A real pending signal will be wired in a
  // later slice (see the note in `lib/device/devicePowerCalibrationStore.ts`).

  it('returns null for off-step reports (planning 0W)', () => {
    const store = memoryStore();
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({
      reportedStepId: 'off',
      measuredPowerKw: 0,
    }), 0);
    expect(outcome).toBeNull();
  });

  it('rejects samples above the reported step configured power', () => {
    const store = memoryStore();
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({
      reportedStepId: 'low',
      measuredPowerKw: 1.81,
    }), 0);
    expect(outcome?.accepted).toBe(false);
    if (outcome && !outcome.accepted) expect(outcome.reason).toBe('above_step_ceiling');
    expect(store.getSnapshot().devices['hoiax-1']).toBeUndefined();
  });

  it('rejects samples at or below the configured power for the step underneath', () => {
    const store = memoryStore();
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({
      reportedStepId: 'medium',
      measuredPowerKw: 1.25,
    }), 0);
    expect(outcome?.accepted).toBe(false);
    if (outcome && !outcome.accepted) expect(outcome.reason).toBe('below_lower_step');
    expect(store.getSnapshot().devices['hoiax-1']).toBeUndefined();
  });

  it('records samples inside the reported step power band', () => {
    const store = memoryStore();
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({
      reportedStepId: 'medium',
      measuredPowerKw: 1.5,
    }), 0);
    expect(outcome?.accepted).toBe(true);
    expect(store.getSnapshot().devices['hoiax-1'].steps.medium.observedKw).toBeCloseTo(1.5);
  });

  it('returns null for snapshots without a stepped-load profile', () => {
    const store = memoryStore();
    const outcome = store.ingestDeviceSnapshot({
      id: 'binary-1',
      name: 'Lamp',
      targets: [],
      binaryControl: { on: true },
      measuredPowerKw: 0.05,
    } as unknown as TargetDeviceSnapshot, 0);
    expect(outcome).toBeNull();
  });

  it('returns null without a finite lastFreshDataMs', () => {
    // Without freshness, the per-sample freshness gate inside `recordSample`
    // would short-circuit; the eligibility predicate must filter these out.
    const store = memoryStore();
    const outcome = store.ingestDeviceSnapshot(
      baseDeviceSnapshot({ lastFreshDataMs: undefined }),
      0,
    );
    expect(outcome).toBeNull();
  });
});

describe('PowerCalibrationStore persistence', () => {
  it('writes an accepted sample through, one row per device, and reads it back on the next boot', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = memoryStore(db);
    expect(store.getSnapshot().devices).toEqual({});
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ id: 'hoiax-2' }), 0);
    expect(rowCount(db)).toBe(2);
    expect(memoryStore(db).getSnapshot()).toEqual(store.getSnapshot());
  });

  it('rewrites only the device the sample changed', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = memoryStore(db);
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ id: 'hoiax-2' }), 0);
    const before = totalChanges(db);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ measuredPowerKw: 2.8, lastFreshDataMs: 30_000 }), 30_000);
    expect(totalChanges(db) - before).toBe(1);
  });

  it('a rejected sample writes nothing', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = memoryStore(db);
    const before = totalChanges(db);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ reportedStepId: 'low', measuredPowerKw: 1.81 }), 0);
    expect(totalChanges(db) - before).toBe(0);
  });

  it('prunes devices untouched past the retention, on disk too', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = memoryStore(db);
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ id: 'hoiax-2', lastFreshDataMs: 50_000 }), 50_000);
    store.prune(80_000, 60_000);
    expect(Object.keys(store.getSnapshot().devices)).toEqual(['hoiax-2']);
    expect(Object.keys(memoryStore(db).getSnapshot().devices)).toEqual(['hoiax-2']);
  });

  it('deletes a row that does not read as a device, and keeps the steps that read in one that does', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    memoryStore(db).ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
    const insert = db.prepare('INSERT INTO power_calibration_devices (device_id, calibration_json) VALUES (?, ?)');
    insert.run('broken', '{not json');
    insert.run('no-steps', JSON.stringify({ lastTouchedMs: 1 }));
    insert.run('partial', JSON.stringify({ lastTouchedMs: 1, steps: { ok: step(1, 2), bad: { observedKw: 'x' } } }));
    const capture = captureLogger();
    try {
      const devices = memoryStore(db).getSnapshot().devices;
      expect(Object.keys(devices).sort()).toEqual(['hoiax-1', 'partial']);
      expect(Object.keys(devices.partial.steps)).toEqual(['ok']);
      expect(capture.findEvents('userdata_row_quarantined')).toHaveLength(2);
    } finally {
      capture.restore();
    }
    expect(rowCount(db)).toBe(2);
  });

  it('keeps a sample whose write failed, and writes it with the next one', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = memoryStore(db);
    const capture = captureLogger();
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('disk full'); });
    try {
      expect(store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0)?.accepted).toBe(true);
      expect(capture.findEvent('power_calibration_persist_failed')).toBeDefined();
    } finally {
      stringify.mockRestore();
      capture.restore();
    }
    expect(store.getSnapshot().devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
    expect(rowCount(db)).toBe(0);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ id: 'hoiax-2' }), 0);
    expect(memoryStore(db).getSnapshot()).toEqual(store.getSnapshot());
  });
});

describe('importLegacyPowerCalibration', () => {
  // Written by a build before the step floor: version 1 and no mark.
  // Production's 6 A rung learned 0.79 kW against 1.38 kW (57 %); the water
  // heater's rung sits at 96 % of nameplate and must survive.
  const legacyBlob = {
    version: 1,
    devices: {
      elbillader: { steps: { '6a': step(0.79, 1.38) }, lastTouchedMs: 1_000 },
      'hoiax-1': { steps: { max: step(2.87, 3) }, lastTouchedMs: 1_000 },
    },
  };
  const markedBlob = { ...legacyBlob, stepFloorApplied: true };
  const expectedReset = { deviceId: 'elbillader', stepId: '6a', observedKw: 0.79, nameplateAtSampleKw: 1.38 };

  const rig = () => {
    const settings = new MockSettings();
    // A real install never has an empty key list here: the boot migrations
    // set their markers first.
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    return { settings, db, repository: createPowerCalibrationRepository(db) };
  };

  it('imports the blob into an empty store and retires the key; a second boot has nothing to do', () => {
    const { settings, db, repository } = rig();
    settings.set(POWER_CALIBRATION, markedBlob);
    importLegacyPowerCalibration(settings, repository);
    expect(memoryStore(db).getSnapshot()).toEqual({ version: 1, devices: legacyBlob.devices });
    expect(settings.get(POWER_CALIBRATION)).toBeNull();
    const get = vi.spyOn(settings, 'get');
    importLegacyPowerCalibration(settings, repository);
    expect(get).not.toHaveBeenCalled();
  });

  it('drops the under-learned steps of a blob without the step-floor mark, naming them once', () => {
    const { settings, db, repository } = rig();
    settings.set(POWER_CALIBRATION, legacyBlob);
    const capture = captureLogger();
    try {
      importLegacyPowerCalibration(settings, repository);
      expect(capture.findEvents('power_calibration_under_learned_steps_reset')).toEqual([
        expect.objectContaining({ resetCount: 1, resetSteps: [expectedReset] }),
      ]);
    } finally {
      capture.restore();
    }
    const devices = memoryStore(db).getSnapshot().devices;
    expect(devices.elbillader.steps).toEqual({});
    expect(devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.87);
  });

  // A boot whose import deferred still calibrates; the next boot's import
  // keeps both, the store's step winning where both learned one.
  it('imports the blob under what the store already holds, per device and step', () => {
    const { settings, db, repository } = rig();
    const store = memoryStore(db);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 2_000 }), 2_000);
    settings.set(POWER_CALIBRATION, {
      ...markedBlob,
      devices: {
        ...markedBlob.devices,
        'hoiax-1': { steps: { max: step(2.87, 3), low: step(1.2, 1.25) }, lastTouchedMs: 1_000 },
      },
    });
    importLegacyPowerCalibration(settings, repository);
    const devices = memoryStore(db).getSnapshot().devices;
    expect(devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
    expect(devices['hoiax-1'].steps.low.observedKw).toBeCloseTo(1.2);
    expect(devices['hoiax-1'].lastTouchedMs).toBe(2_000);
    expect(devices.elbillader.steps['6a'].observedKw).toBeCloseTo(0.79);
    expect(settings.get(POWER_CALIBRATION)).toBeNull();
  });

  // One transient must never cost the calibration: a suspect read leaves the
  // key where it is for the next boot.
  it('defers on a suspect read, a value with no calibration in it, or a store that cannot answer', () => {
    const { settings, db, repository } = rig();
    settings.set(POWER_CALIBRATION, { version: 999, devices: 'garbage' });
    importLegacyPowerCalibration(settings, repository);
    expect(settings.get(POWER_CALIBRATION)).toEqual({ version: 999, devices: 'garbage' });
    settings.set(POWER_CALIBRATION, markedBlob);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === POWER_CALIBRATION ? undefined : originalGet(key)));
    importLegacyPowerCalibration(settings, repository);
    get.mockRestore();
    const write = vi.spyOn(repository, 'write').mockImplementation(() => { throw new Error('disk full'); });
    importLegacyPowerCalibration(settings, repository);
    write.mockRestore();
    expect(memoryStore(db).getSnapshot().devices).toEqual({});
    expect(originalGet(POWER_CALIBRATION)).toEqual(markedBlob);
    importLegacyPowerCalibration(settings, repository);
    expect(Object.keys(memoryStore(db).getSnapshot().devices).sort()).toEqual(['elbillader', 'hoiax-1']);
    expect(settings.get(POWER_CALIBRATION)).toBeNull();
  });
});
