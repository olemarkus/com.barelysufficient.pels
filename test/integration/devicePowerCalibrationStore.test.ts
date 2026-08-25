import { beforeEach, describe, expect, it } from 'vitest';
import {
  PowerCalibrationStore,
  loadPowerCalibrationStore,
  persistPowerCalibrationFlush,
  persistPowerCalibrationIfDue,
} from '../../lib/device/devicePowerCalibrationStore';
import {
  POWER_CALIBRATION_VERSION,
  createEmptyPowerCalibrationSnapshot,
} from '../../lib/device/devicePowerCalibration';
import type {
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { captureLogger } from '../utils/loggerCapture';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import { POWER_CALIBRATION, POWER_CALIBRATION_INITIALIZED } from '../../lib/utils/settingsKeys';

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

describe('PowerCalibrationStore.ingestDeviceSnapshot', () => {
  it('records a sample for a confirmed stepped-load snapshot', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 0 }), 0);
    expect(outcome?.accepted).toBe(true);
    expect(store.getSnapshot().devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
  });

  it('returns null when there is no reported step (assumed-step fallback only)', () => {
    // Sampling on an assumed step would attribute measured power to a step the
    // device may never have visited. The producer only sets `reportedStepId`
    // from real native/flow telemetry, so its absence is the eligibility gate.
    const store = new PowerCalibrationStore();
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({ reportedStepId: undefined }), 0);
    expect(outcome).toBeNull();
  });

  // The former `stepCommandPending` ingest guard was removed in the snapshot
  // decomposition: `stepCommandPending` is app-layer decoration the raw
  // `getSnapshot()` ingest path never carried, so the guard was an
  // always-false no-op in production. A real pending signal will be wired in a
  // later slice (see TODO in devicePowerCalibrationStore.ts).

  it('returns null for off-step reports (planning 0W)', () => {
    const store = new PowerCalibrationStore();
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({
      reportedStepId: 'off',
      measuredPowerKw: 0,
    }), 0);
    expect(outcome).toBeNull();
  });

  it('rejects samples above the reported step configured power', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({
      reportedStepId: 'low',
      measuredPowerKw: 1.81,
    }), 0);
    expect(outcome?.accepted).toBe(false);
    if (outcome && !outcome.accepted) expect(outcome.reason).toBe('above_step_ceiling');
    expect(store.getSnapshot().devices['hoiax-1']).toBeUndefined();
  });

  it('rejects samples at or below the configured power for the step underneath', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({
      reportedStepId: 'medium',
      measuredPowerKw: 1.25,
    }), 0);
    expect(outcome?.accepted).toBe(false);
    if (outcome && !outcome.accepted) expect(outcome.reason).toBe('below_lower_step');
    expect(store.getSnapshot().devices['hoiax-1']).toBeUndefined();
  });

  it('records samples inside the reported step power band', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const outcome = store.ingestDeviceSnapshot(baseDeviceSnapshot({
      reportedStepId: 'medium',
      measuredPowerKw: 1.5,
    }), 0);
    expect(outcome?.accepted).toBe(true);
    expect(store.getSnapshot().devices['hoiax-1'].steps.medium.observedKw).toBeCloseTo(1.5);
  });

  it('returns null for snapshots without a stepped-load profile', () => {
    const store = new PowerCalibrationStore();
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
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    const outcome = store.ingestDeviceSnapshot(
      baseDeviceSnapshot({ lastFreshDataMs: undefined }),
      0,
    );
    expect(outcome).toBeNull();
  });
});

describe('PowerCalibrationStore persistence flow', () => {
  it('snapshotForPersist honors the debounce window without mutating state', () => {
    const store = new PowerCalibrationStore({ persistDebounceMs: 60_000 });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
    const capture = captureLogger();
    let wrote: boolean;
    try {
      wrote = persistPowerCalibrationIfDue({
        homey,
        store,
        nowMs: 0,
      });
      expect(wrote).toBe(false);
      expect(capture.findEvent('power_calibration_persist_failed')).toMatchObject({
        event: 'power_calibration_persist_failed',
      });
    } finally {
      capture.restore();
    }
    // Critical: the store must remain dirty so the same samples are retried
    // on the next persist tick rather than silently lost.
    expect(store.isDirty()).toBe(true);
  });

  it('marks the store clean only after a successful write', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = new PowerCalibrationStore({ persistDebounceMs: 0 });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
    persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 0,
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
    seed.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    expect(store.isDirty()).toBe(true);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 70_000,
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    expect(wrote).toBe(false);
  });
});

describe('fresh-install vs transient-miss discriminator', () => {
  it('treats a brand-new install (no marker, raw missing) as fresh — no grace', () => {
    // No marker has ever been written and no calibration data exists. There
    // is nothing on disk to preserve, so the load-grace window must NOT
    // engage; the first sample should persist immediately. Otherwise per-step
    // EMAs collected in the first 5 minutes after install/restart are lost
    // if the app crashes during the grace window.
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    expect(wrote).toBe(true);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeDefined();
  });

  it('engages grace when the marker is set but raw is missing (transient SDK miss)', () => {
    // The marker indicates we have persisted before, so a missing raw value
    // is a transient SDK read failure, not a fresh install. The grace window
    // must engage to avoid overwriting prior history with a freshly-empty
    // in-memory snapshot.
    const homeyStore = new Map<string, unknown>([
      [POWER_CALIBRATION_INITIALIZED, true],
    ]);
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    expect(wrote).toBe(false);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeUndefined();
  });

  it('writes the marker on first successful persist', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    expect(homeyStore.get(POWER_CALIBRATION_INITIALIZED)).toBe(true);
  });

  it('writes the marker on successful persist even when marker read throws', () => {
    // Regression: if readInitMarker throws transiently after a successful
    // persist, the marker write was previously skipped. Combined with a
    // later boot where the snapshot read also throws (or returns null),
    // the install would be misclassified as fresh and overwrite history.
    // The marker must be written best-effort whenever it is not confirmed
    // already present.
    const writes: Array<[string, unknown]> = [];
    const homey = {
      settings: {
        get: (key: string): unknown => {
          if (key === POWER_CALIBRATION_INITIALIZED) throw new Error('transient SDK miss');
          return undefined;
        },
        set: (key: string, value: unknown): void => {
          writes.push([key, value]);
        },
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      // loadGraceMs:0 to bypass the grace window so the persist runs and the
      // marker-write path is exercised.
      options: { persistDebounceMs: 0, nowMs: 1_000, loadGraceMs: 0 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    const markerWrites = writes.filter(([key]) => key === POWER_CALIBRATION_INITIALIZED);
    expect(markerWrites).toHaveLength(1);
    expect(markerWrites[0]?.[1]).toBe(true);
  });

  it('sets the marker when loading a plausible existing snapshot (upgrade migration)', () => {
    // Existing users who upgrade may have valid persisted data but no marker
    // yet. The first load should set the marker so subsequent transient
    // misses are recognised as such rather than misclassified as fresh.
    const homeyStore = new Map<string, unknown>([
      [POWER_CALIBRATION, { version: 1, devices: {} }],
    ]);
    const homey = mockHomey(homeyStore);
    loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    expect(homeyStore.get(POWER_CALIBRATION_INITIALIZED)).toBe(true);
  });

  it('still engages grace on malformed raw regardless of marker state', () => {
    // A malformed object (not just missing) is always treated as a corrupt
    // read — grace engages to avoid overwriting history with the rebuilt
    // empty snapshot.
    const homeyStore = new Map<string, unknown>([
      [POWER_CALIBRATION, { version: 1, devices: 'bad' }],
    ]);
    const homey = mockHomey(homeyStore);
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    expect(wrote).toBe(false);
  });

  it('engages grace when the snapshot read throws (does not crash startup)', () => {
    // A transient SDK throw must not propagate out of the loader; the
    // throw is also treated as a missing read so the grace window engages
    // and a subsequent recovery read can rebuild the prior history.
    const homey = {
      settings: {
        get: (key: string): unknown => {
          if (key === POWER_CALIBRATION) throw new Error('transient SDK miss');
          if (key === POWER_CALIBRATION_INITIALIZED) return true;
          return undefined;
        },
        set: () => undefined,
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    expect(wrote).toBe(false);
  });

  it('engages grace when the snapshot read throws even if the marker is absent', () => {
    // Regression: an upgrading install legitimately has no marker on first
    // post-upgrade boot. If the snapshot read also throws transiently, the
    // loader must NOT collapse into the fresh-install branch (rawIsAbsent &&
    // !hasInitMarker) — that would overwrite prior history on the next
    // persist. A thrown read forces grace regardless of marker state.
    const homey = {
      settings: {
        get: (key: string): unknown => {
          if (key === POWER_CALIBRATION) throw new Error('transient SDK miss');
          if (key === POWER_CALIBRATION_INITIALIZED) return undefined;
          return undefined;
        },
        set: () => undefined,
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    expect(wrote).toBe(false);
  });

  it('engages grace when both snapshot and marker reads throw', () => {
    // Paired SDK throws on startup must not be misclassified as a fresh
    // install. The marker read throw is the load-bearing detail here: if
    // the loader treated a thrown marker read as "marker absent", the
    // combined absent-raw + absent-marker would skip the grace window and
    // the next persist would overwrite the persisted history with the
    // freshly-empty in-memory snapshot.
    let getCallCount = 0;
    const homey = {
      settings: {
        get: (): unknown => {
          getCallCount += 1;
          throw new Error('SDK unavailable');
        },
        set: () => undefined,
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    expect(getCallCount).toBeGreaterThanOrEqual(2);
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
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
    reloaded.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationFlush({
      homey: homey as never,
      store: reloaded,
      nowMs: 1_500,
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
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 1_500);
    const wrote = persistPowerCalibrationFlush({
      homey: homey as never,
      store,
      nowMs: 1_500,
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
    });
    expect(wrote).toBe(false);
  });
});

describe('persistPowerCalibrationIfDue', () => {
  it('writes when the store is dirty and debounce has passed', () => {
    const homeyStore = new Map<string, unknown>();
    const homey = mockHomey(homeyStore);
    const store = new PowerCalibrationStore({ persistDebounceMs: 1_000 });
    store.ingestDeviceSnapshot(baseDeviceSnapshot(), 0);
    const wrote = persistPowerCalibrationIfDue({
      homey: homey as never,
      store,
      nowMs: 1_500,
    });
    expect(wrote).toBe(true);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeDefined();
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
    });
    expect(wrote).toBe(false);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeUndefined();
  });
});

describe('first-write recovery re-read', () => {
  // The abandon-grace window only blocks writes; these tests pin the behaviour
  // that actually recovers the value: the write path re-reads the persisted
  // snapshot before its first post-grace write and merges what it finds.
  const historicStep = (observedKw: number): Record<string, unknown> => ({
    observedKw,
    nameplateAtSampleKw: 3,
    samples: 8,
    sustainedSeconds: 900,
    lastSampleMs: 500,
  });
  const historicBlob = {
    version: POWER_CALIBRATION_VERSION,
    devices: {
      'historic-1': { steps: { high: historicStep(2.9) }, lastTouchedMs: 500 },
      // Same device the in-memory store re-observes, but a different step.
      'hoiax-1': { steps: { low: historicStep(1.2) }, lastTouchedMs: 500 },
    },
  };
  // Marker present + value absent on load → grace engages (default 5 min from
  // nowMs 1_000, so writes unlock at 301_000 and the transient-miss deferral
  // deadline sits at 601_000).
  const loadWithSuspectRead = (homeyStore: Map<string, unknown>) => {
    homeyStore.set(POWER_CALIBRATION_INITIALIZED, true);
    return loadPowerCalibrationStore({
      homey: mockHomey(homeyStore) as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
  };

  it('merges recovered history under the in-memory state on the first post-grace write', () => {
    const homeyStore = new Map<string, unknown>();
    const store = loadWithSuspectRead(homeyStore);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 1_500 }), 1_500);
    // The transiently-missing value reappears before the first write.
    homeyStore.set(POWER_CALIBRATION, historicBlob);
    const wrote = persistPowerCalibrationIfDue({
      homey: mockHomey(homeyStore) as never,
      store,
      nowMs: 302_000,
    });
    expect(wrote).toBe(true);
    const written = homeyStore.get(POWER_CALIBRATION) as PowerCalibrationSnapshot;
    // Recovered device the in-memory store never saw.
    expect(written.devices['historic-1'].steps.high.observedKw).toBeCloseTo(2.9);
    // Shared device: recovered fills the step memory has not re-visited …
    expect(written.devices['hoiax-1'].steps.low.observedKw).toBeCloseTo(1.2);
    // … and the in-memory EMA wins the step both sides carry.
    expect(written.devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
  });

  it('defers the write while the re-read still misses inside the deferral deadline', () => {
    const homeyStore = new Map<string, unknown>();
    const store = loadWithSuspectRead(homeyStore);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 1_500 }), 1_500);
    const wrote = persistPowerCalibrationIfDue({
      homey: mockHomey(homeyStore) as never,
      store,
      nowMs: 302_000,
    });
    expect(wrote).toBe(false);
    expect(store.isDirty()).toBe(true);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeUndefined();
  });

  it('arms the transient-miss deadline at the FIRST deferred attempt, not at boot', () => {
    // Regression: a boot-anchored deadline let a store whose first mutation
    // arrived late abandon recovery on a SINGLE re-read — the very overwrite
    // the recovery exists to prevent. The window must start at the first
    // deferral so spaced re-reads actually happen.
    const homeyStore = new Map<string, unknown>();
    const store = loadWithSuspectRead(homeyStore);
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 1_500 }), 1_500);
    // First attempt lands long past boot + grace + window — it must still
    // DEFER (and arm the window), never abandon outright.
    expect(persistPowerCalibrationIfDue({
      homey: mockHomey(homeyStore) as never,
      store,
      nowMs: 2_000_000,
    })).toBe(false);
    expect(homeyStore.get(POWER_CALIBRATION)).toBeUndefined();
    // Once the armed window has elapsed with the value still absent, the key
    // is genuinely gone and the write proceeds.
    const wrote = persistPowerCalibrationIfDue({
      homey: mockHomey(homeyStore) as never,
      store,
      nowMs: 2_000_000 + 300_000,
    });
    expect(wrote).toBe(true);
    const written = homeyStore.get(POWER_CALIBRATION) as PowerCalibrationSnapshot;
    expect(written.devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
  });

  it('throttles deferred recovery re-reads to the persist debounce window', () => {
    // While recovery defers, the ordinary debounce never advances (no
    // successful write), so without its own throttle the deferral path would
    // re-read settings and log on every 10 s power sample.
    let calibrationReads = 0;
    const marker = { present: true };
    const homey = {
      settings: {
        get: (key: string): unknown => {
          if (key === POWER_CALIBRATION_INITIALIZED) return marker.present;
          if (key === POWER_CALIBRATION) {
            calibrationReads += 1;
            return undefined;
          }
          return undefined;
        },
        set: (): void => {},
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 60_000, nowMs: 1_000 },
    });
    const readsAfterLoad = calibrationReads;
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 1_500 }), 1_500);
    // Flush bypasses the ordinary debounce, so only the recovery throttle
    // separates these two attempts 10 s apart.
    expect(persistPowerCalibrationFlush({ homey: homey as never, store, nowMs: 302_000 })).toBe(false);
    expect(calibrationReads).toBe(readsAfterLoad + 1);
    expect(persistPowerCalibrationFlush({ homey: homey as never, store, nowMs: 312_000 })).toBe(false);
    expect(calibrationReads).toBe(readsAfterLoad + 1);
  });

  it('writes through immediately when the re-read finds neither value nor marker (genuine wipe)', () => {
    // Boot read threw → grace engaged. At recovery time the SDK answers:
    // value absent AND marker absent — nothing was ever (or is any longer)
    // persisted, so the first post-grace attempt writes without deferral.
    const phase = { healed: false };
    const writes = new Map<string, unknown>();
    const homey = {
      settings: {
        get: (key: string): unknown => {
          if (key === POWER_CALIBRATION && !phase.healed) throw new Error('SDK unavailable');
          return undefined;
        },
        set: (key: string, value: unknown): void => { writes.set(key, value); },
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 1_500 }), 1_500);
    phase.healed = true;
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 302_000 })).toBe(true);
    expect(writes.has(POWER_CALIBRATION)).toBe(true);
  });

  it('gives the transient-miss arm its own full window after a long thrown phase', () => {
    // Regression: the thrown and transient-miss arms once shared ONE deferral
    // window. A long thrown phase armed and expired it, so the first
    // non-throwing read — transiently absent, the exact falsy mode this repo
    // pins — hit past_window immediately and destructively settled after
    // ZERO spaced absent re-reads. Each arm must own its window.
    const phase = { throwing: true };
    const writes = new Map<string, unknown>();
    const counter = { snapshotReads: 0 };
    const homey = {
      settings: {
        get: (key: string): unknown => {
          if (key === POWER_CALIBRATION_INITIALIZED) return true;
          if (key === POWER_CALIBRATION) {
            counter.snapshotReads += 1;
            if (phase.throwing) throw new Error('SDK unavailable');
            return undefined;
          }
          return undefined;
        },
        set: (key: string, value: unknown): void => { writes.set(key, value); },
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 1_500 }), 1_500);
    // Thrown deferrals arm the thrown arm's window (302_000 → 602_000) and
    // keep deferring well past it.
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 302_000 })).toBe(false);
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 700_000 })).toBe(false);
    // The SDK heals into the transiently-absent mode.
    phase.throwing = false;
    const readsBeforeMiss = counter.snapshotReads;
    // The first absent read must DEFER and arm the miss arm's OWN window —
    // a shared window would already be expired and abandon right here.
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 701_000 })).toBe(false);
    expect(writes.has(POWER_CALIBRATION)).toBe(false);
    // Spaced absent re-reads actually happen inside the miss window.
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 800_000 })).toBe(false);
    expect(counter.snapshotReads).toBe(readsBeforeMiss + 2);
    expect(writes.has(POWER_CALIBRATION)).toBe(false);
    // Only once the miss window (armed at 701_000) elapses does the write go.
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 1_001_000 })).toBe(true);
    expect(writes.has(POWER_CALIBRATION)).toBe(true);
  });

  it('defers when the value is absent and the marker read throws at recovery time', () => {
    // An unreadable marker must be treated as marker-present: inverting it
    // would let a transient marker-read failure abandon recovery and
    // overwrite live history.
    const phase = { markerThrows: false };
    const writes = new Map<string, unknown>();
    const homey = {
      settings: {
        get: (key: string): unknown => {
          if (key === POWER_CALIBRATION_INITIALIZED) {
            if (phase.markerThrows) throw new Error('SDK unavailable');
            return true;
          }
          return undefined;
        },
        set: (key: string, value: unknown): void => { writes.set(key, value); },
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 1_500 }), 1_500);
    phase.markerThrows = true;
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 302_000 })).toBe(false);
    expect(store.isDirty()).toBe(true);
    expect(writes.has(POWER_CALIBRATION)).toBe(false);
  });

  it('defers a throwing re-read past any deadline, then merges once the SDK heals', () => {
    // A deadline on the thrown arm would overwrite the history at exactly the
    // moment the SDK heals; deferring loses nothing because the paired write
    // would almost certainly fail too.
    let healed = false;
    const writes = new Map<string, unknown>();
    const homey = {
      settings: {
        get: (key: string): unknown => {
          if (key === POWER_CALIBRATION_INITIALIZED) return true;
          if (key === POWER_CALIBRATION) {
            if (!healed) throw new Error('SDK unavailable');
            return historicBlob;
          }
          return undefined;
        },
        set: (key: string, value: unknown): void => { writes.set(key, value); },
      },
    };
    const store = loadPowerCalibrationStore({
      homey: homey as never,
      options: { persistDebounceMs: 0, nowMs: 1_000 },
    });
    store.ingestDeviceSnapshot(baseDeviceSnapshot({ lastFreshDataMs: 1_500 }), 1_500);
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 2_000_000 })).toBe(false);
    expect(persistPowerCalibrationFlush({ homey: homey as never, store, nowMs: 2_000_000 })).toBe(false);
    expect(writes.has(POWER_CALIBRATION)).toBe(false);
    healed = true;
    expect(persistPowerCalibrationIfDue({ homey: homey as never, store, nowMs: 2_100_000 })).toBe(true);
    const written = writes.get(POWER_CALIBRATION) as PowerCalibrationSnapshot;
    expect(written.devices['historic-1'].steps.high.observedKw).toBeCloseTo(2.9);
    expect(written.devices['hoiax-1'].steps.max.observedKw).toBeCloseTo(2.75);
  });
});
