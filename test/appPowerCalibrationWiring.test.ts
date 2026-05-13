import { beforeEach, describe, expect, it } from 'vitest';
import {
  PowerCalibrationStore,
  loadPowerCalibrationStore,
  persistPowerCalibrationFlush,
  persistPowerCalibrationIfDue,
} from '../lib/app/appPowerCalibrationWiring';
import {
  POWER_CALIBRATION_VERSION,
  createEmptyPowerCalibrationSnapshot,
} from '../lib/observer/devicePowerCalibration';
import type { SteppedLoadProfile, TargetDeviceSnapshot } from '../lib/utils/types';
import { POWER_CALIBRATION } from '../lib/utils/settingsKeys';

const CONNECTED_300_PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const baseDeviceSnapshot = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id: 'hoiax-1',
  name: 'Hoiax',
  targets: [],
  controlModel: 'stepped_load',
  steppedLoadProfile: CONNECTED_300_PROFILE,
  reportedStepId: 'max',
  actualStepId: 'max',
  actualStepSource: 'reported',
  measuredPowerKw: 2.75,
  currentOn: true,
  lastFreshDataMs: 0,
  ...overrides,
}) as TargetDeviceSnapshot;

type MockSettings = {
  store: Map<string, unknown>;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
};

const mockHomey = (store: Map<string, unknown> = new Map()): { settings: MockSettings } => ({
  settings: {
    store,
    get(key) { return this.store.get(key); },
    set(key, value) { this.store.set(key, value); },
  },
});

describe('PowerCalibrationStore.ingestDevices', () => {
  it('records a sample for a confirmed stepped-load snapshot', () => {
    const store = new PowerCalibrationStore({
      persistDebounceMs: 0,
    });
    const stats = store.ingestDevices([baseDeviceSnapshot({ lastFreshDataMs: 0 })], 0);
    expect(stats.accepted).toBe(1);
    expect(stats.skipped).toBe(0);
    const snapshot = store.getSnapshot();
    expect(snapshot.devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
  });

  it('skips when reportedStepId does not match actualStepId', () => {
    const store = new PowerCalibrationStore();
    const stats = store.ingestDevices(
      [baseDeviceSnapshot({ actualStepId: 'medium' })],
      0,
    );
    expect(stats.accepted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('skips when a step command is pending', () => {
    const store = new PowerCalibrationStore();
    const stats = store.ingestDevices(
      [baseDeviceSnapshot({ stepCommandPending: true })],
      0,
    );
    expect(stats.accepted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('skips off-step reports (planning 0W)', () => {
    const store = new PowerCalibrationStore();
    const stats = store.ingestDevices(
      [baseDeviceSnapshot({
        reportedStepId: 'off',
        actualStepId: 'off',
        measuredPowerKw: 0,
      })],
      0,
    );
    expect(stats.accepted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('skips snapshots without a stepped-load profile', () => {
    const store = new PowerCalibrationStore();
    const stats = store.ingestDevices(
      [{
        id: 'binary-1',
        name: 'Lamp',
        targets: [],
        currentOn: true,
        measuredPowerKw: 0.05,
      } as unknown as TargetDeviceSnapshot],
      0,
    );
    expect(stats.accepted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('skips snapshots whose actualStepSource is not "reported"', () => {
    // Sampling on an assumed step would attribute measured power to a step
    // the device may never have visited; the wiring layer must filter these
    // out before the EMA is touched.
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const stats = store.ingestDevices(
      [baseDeviceSnapshot({ actualStepSource: 'assumed' })],
      0,
    );
    expect(stats.accepted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('skips snapshots without a finite lastFreshDataMs', () => {
    // Without freshness, the per-sample freshness gate inside `recordSample`
    // short-circuits — bypassing the documented 60-second window. The wiring
    // layer must reject these before they reach the store.
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const stats = store.ingestDevices(
      [baseDeviceSnapshot({ lastFreshDataMs: undefined })],
      0,
    );
    expect(stats.accepted).toBe(0);
    expect(stats.skipped).toBe(1);
  });
});

describe('PowerCalibrationStore persistence flow', () => {
  it('snapshotForPersist honors the debounce window without mutating state', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 60_000 });
    store.ingestDevices([baseDeviceSnapshot()], 0);
    // Even though dirty, the first call uses lastPersistMs=0 and (0-0)=0 < 60_000.
    expect(store.snapshotForPersist(0)).toBe(null);
    expect(store.snapshotForPersist(60_000)).not.toBe(null);
    // Read does not mutate — same call again still returns the snapshot.
    expect(store.snapshotForPersist(60_000)).not.toBe(null);
    expect(store.isDirty()).toBe(true);
    // After markPersisted, the store is clean.
    store.markPersisted(60_000);
    expect(store.snapshotForPersist(120_000)).toBe(null);
    expect(store.isDirty()).toBe(false);
  });

  it('snapshotForFlush returns the snapshot regardless of debounce', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 60_000 });
    store.ingestDevices([baseDeviceSnapshot()], 0);
    expect(store.snapshotForFlush(0)).not.toBe(null);
    expect(store.isDirty()).toBe(true);
    store.markPersisted(0);
    expect(store.isDirty()).toBe(false);
  });

  it('snapshotForFlush honors the load-grace window', () => {
    // A shutdown inside the grace window must not overwrite previously
    // persisted (but unreadable on startup) calibration history with the
    // freshly-empty in-memory snapshot.
    const store = new PowerCalibrationStore({
      persistDebounceMs: 0,
      nowMs: 1_000,
      loadGraceMs: 60_000,
    });
    store.ingestDevices([baseDeviceSnapshot()], 1_500);
    expect(store.snapshotForFlush(1_500)).toBe(null);
    expect(store.isDirty()).toBe(true);
    // Past the grace window, flush returns the snapshot as usual.
    expect(store.snapshotForFlush(70_000)).not.toBe(null);
  });
});

describe('write-failure recovery', () => {
  it('keeps the store dirty when settings.set throws', () => {
    const homey = {
      settings: {
        get: () => undefined,
        set: () => {
          throw new Error('boom');
        },
      },
    } as never;
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    store.ingestDevices([baseDeviceSnapshot()], 0);
    const errors: Array<[string, Error]> = [];
    const wrote = persistPowerCalibrationIfDue({
      homey,
      store,
      nowMs: 0,
      error: (msg, err) => errors.push([msg, err]),
    });
    expect(wrote).toBe(false);
    expect(errors).toHaveLength(1);
    // Critical: the store must remain dirty so the same samples are retried
    // on the next persist tick rather than silently lost.
    expect(store.isDirty()).toBe(true);
  });

  it('marks the store clean only after a successful write', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    store.ingestDevices([baseDeviceSnapshot()], 0);
    persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 0,
      error: () => undefined,
    });
    expect(homeyStore.get(POWER_CALIBRATION)).toBeDefined();
    expect(store.isDirty()).toBe(false);
  });
});

describe('loadPowerCalibrationStore', () => {
  let homeyStore: Map<string, unknown>;
  let homey: ReturnType<typeof mockHomey>;

  beforeEach(() => {
    homeyStore = new Map();
    homey = mockHomey(homeyStore);
  });

  it('loads an empty snapshot when settings are absent', () => {
    const store = loadPowerCalibrationStore({ homey: homey as never });
    const snapshot = store.getSnapshot();
    expect(snapshot.version).toBe(POWER_CALIBRATION_VERSION);
    expect(Object.keys(snapshot.devices)).toHaveLength(0);
  });

  it('round-trips through settings', () => {
    const seed = new PowerCalibrationStore({ persistDebounceMs: 0 });
    seed.ingestDevices([baseDeviceSnapshot()], 0);
    const seedSnapshot = seed.snapshotForFlush(0);
    expect(seedSnapshot).not.toBe(null);
    if (seedSnapshot === null) return;
    homeyStore.set(POWER_CALIBRATION, seedSnapshot);

    const reloaded = loadPowerCalibrationStore({ homey: homey as never });
    const reloadedSnapshot = reloaded.getSnapshot();
    expect(reloadedSnapshot.devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
  });

  it('treats malformed stored snapshots as empty (abandon-grace)', () => {
    homeyStore.set(POWER_CALIBRATION, { version: 999, devices: 'garbage' });
    const store = loadPowerCalibrationStore({ homey: homey as never });
    expect(Object.keys(store.getSnapshot().devices)).toHaveLength(0);
  });
});

describe('abandon-grace on missing settings load', () => {
  it('refuses to persist while the load-grace window is active', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000, loadGraceMs: 60_000 },
    });
    store.ingestDevices([baseDeviceSnapshot()], 1_500);
    expect(store.isDirty()).toBe(true);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
      error: () => undefined,
    });
    expect(wrote).toBe(false);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeUndefined();
  });

  it('allows persistence once the grace window has elapsed', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000, loadGraceMs: 60_000 },
    });
    store.ingestDevices([baseDeviceSnapshot()], 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 70_000,
      error: () => undefined,
    });
    expect(wrote).toBe(true);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeDefined();
  });

  it('skips the grace window when the persisted snapshot was plausible', () => {
    const homeyStore = new Map<string, unknown>([
      [POWER_CALIBRATION, { version: 1, devices: {} }],
    ]);
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDevices([baseDeviceSnapshot()], 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
      error: () => undefined,
    });
    expect(wrote).toBe(true);
  });

  it('engages the grace window when devices is not a plain record', () => {
    // The normaliser would drop this to empty; without a stricter
    // plausibility check the first sample after a partial corrupt read
    // would persist the freshly-empty snapshot and erase prior history.
    const homeyStore = new Map<string, unknown>([
      [POWER_CALIBRATION, { version: 1, devices: 'bad' }],
    ]);
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDevices([baseDeviceSnapshot()], 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
      error: () => undefined,
    });
    expect(wrote).toBe(false);
    expect(homeyStore.get(POWER_CALIBRATION)).toEqual({ version: 1, devices: 'bad' });
  });

  it('engages the grace window when the version is unknown', () => {
    const homeyStore = new Map<string, unknown>([
      [POWER_CALIBRATION, { version: 99, devices: {} }],
    ]);
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDevices([baseDeviceSnapshot()], 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
      error: () => undefined,
    });
    expect(wrote).toBe(false);
  });

  it('engages the grace window when a nested step record is malformed', () => {
    // Devices field is a plausible record and the device entry's shape is
    // valid at the top level, but a nested step record is malformed. The
    // normaliser would drop that step (preserving the device entry with
    // surviving steps), so without nested validation the next persist would
    // overwrite the persisted history with the rebuilt-empty step map.
    const homeyStore = new Map<string, unknown>([
      [POWER_CALIBRATION, {
        version: 1,
        devices: {
          'hoiax-1': {
            lastTouchedMs: 100,
            steps: {
              max: { observedKw: 'oops' },
            },
          },
        },
      }],
    ]);
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDevices([baseDeviceSnapshot()], 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
      error: () => undefined,
    });
    expect(wrote).toBe(false);
  });
});

describe('persistPowerCalibrationFlush', () => {
  it('writes the snapshot when only the debounce gate would block', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    // Long debounce, no load-grace (snapshot was plausible on load).
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 60_000, nowMs: 1_000 },
    });
    // Seed the homey store with a plausible empty snapshot so load-grace
    // does not engage.
    homeyStore.set(POWER_CALIBRATION, { version: 1, devices: {} });
    const reloaded = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 60_000, nowMs: 1_000 },
    });
    reloaded.ingestDevices([baseDeviceSnapshot()], 1_500);
    const wrote = persistPowerCalibrationFlush({
      homey: homey as never,
      store: reloaded,
      nowMs: 1_500,
      error: () => undefined,
    });
    expect(wrote).toBe(true);
    expect(reloaded.isDirty()).toBe(false);
    // The originally-loaded store is unchanged.
    void store;
  });

  it('refuses to write while the load-grace window is active', () => {
    // The whole point of load-grace is "don't write our possibly-incomplete
    // state over what's persisted." Flush must honor it; otherwise a shutdown
    // shortly after a transient corrupt load erases the prior history.
    const homeyStore = new Map<string, unknown>([
      // Raw value is absent → grace engages on load.
    ]);
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000, loadGraceMs: 60_000 },
    });
    store.ingestDevices([baseDeviceSnapshot()], 1_500);
    const wrote = persistPowerCalibrationFlush({
      homey: homey as never,
      store,
      nowMs: 1_500,
      error: () => undefined,
    });
    expect(wrote).toBe(false);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeUndefined();
    expect(store.isDirty()).toBe(true);
  });

  it('is a no-op when the store is clean', () => {
    const homey = mockHomey();
    const store = new PowerCalibrationStore();
    const wrote = persistPowerCalibrationFlush({
      homey: homey as never,
      store,
      nowMs: 0,
      error: () => undefined,
    });
    expect(wrote).toBe(false);
  });
});

describe('persistPowerCalibrationIfDue', () => {
  it('writes when the store is dirty and debounce has passed', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = new PowerCalibrationStore({ persistDebounceMs: 1_000 });
    store.ingestDevices([baseDeviceSnapshot()], 0);
    const errors: Array<[string, Error]> = [];
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
      error: (msg, err) => errors.push([msg, err]),
    });
    expect(wrote).toBe(true);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeDefined();
    expect(errors).toEqual([]);
  });

  it('is a no-op when the store is clean', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = new PowerCalibrationStore({
      initialSnapshot: createEmptyPowerCalibrationSnapshot(),
    });
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_000,
      error: () => undefined,
    });
    expect(wrote).toBe(false);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeUndefined();
  });
});
