import { createLearnedPowerPeakState } from '../../lib/device/learnedPowerPeakState';
import {
  createImportingLearnedPowerPeakStore,
  createLearnedPowerPeakRepository,
  type LearnedPowerPeakRepository,
  type LearnedPowerPeakStore,
} from '../../lib/device/learnedPowerPeakStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { DEVICE_POWER_PEAKS } from '../../lib/utils/settingsKeys';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  PEAK_WINDOW_MS,
  PEAK_REANCHOR_INTERVAL_MS,
  type LearnedPeaksByDeviceId,
} from '../../lib/device/devicePowerPeak';
import { onTestFinished } from 'vitest';
import { MockSettings } from '../mocks/homey';
import { captureLogger } from '../utils/loggerCapture';
import { testLogger } from '../utils/testLogger';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

const rowCount = (db: UserdataDatabase): number => (
  (db.prepare('SELECT COUNT(*) AS n FROM device_power_peaks').get() as { n: number }).n
);

/** The settings of an install past its boot migrations, which set their markers first. */
const installSettings = (): MockSettings => {
  const settings = new MockSettings();
  settings.set('boot_migrations_v2_unusable_stepped_config_repaired', true);
  return settings;
};

/**
 * The write-through layer for the learned peaks, over the real repository on an
 * in-memory userdata database. The peak POLICY is unit-tested in
 * `devicePowerPeak.test.ts`; what is under test here is when a peak reaches the
 * store, and when it must not.
 */
describe('learned power peak persistence', () => {
  let db: UserdataDatabase;
  let repository: LearnedPowerPeakRepository;
  let store: LearnedPowerPeakStore;
  let peaks: LearnedPeaksByDeviceId;
  let timers: TimerRegistry;

  const buildState = (getStore: () => LearnedPowerPeakStore = () => store) => (
    createLearnedPowerPeakState({
      getStructuredLogger: () => testLogger,
      getStore,
      getPeaks: () => peaks,
      timers,
    })
  );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    db = openUserdataDatabase(IN_MEMORY_DATABASE);
    repository = createLearnedPowerPeakRepository(db);
    store = createImportingLearnedPowerPeakStore(installSettings(), repository);
    peaks = {};
    timers = new TimerRegistry();
  });

  afterEach(() => {
    timers.clearAll();
    db.close();
    vi.useRealTimers();
  });

  it('adopts the stored peaks at boot', () => {
    repository.write({ heater: { kw: 2, observedAtMs: NOW - 1000 } });
    const state = buildState();

    state.load();

    expect(peaks).toEqual({ heater: { kw: 2, observedAtMs: NOW - 1000 } });
  });

  it('writes nothing over a store the boot read could not see, and merges once a read lands', () => {
    // The cold-boot data-loss shape: the in-memory record is empty too, so a
    // write would make the store hold exactly that and delete every stored row.
    repository.write({ heater: { kw: 2, observedAtMs: NOW - 1000 } });
    let readable = false;
    const flaky: LearnedPowerPeakStore = {
      ...store,
      read: () => {
        if (!readable) throw new Error('transient read failure');
        return repository.read();
      },
    };
    const state = buildState(() => flaky);

    state.load();
    expect(peaks).toEqual({});
    peaks.charger = { kw: 7, observedAtMs: NOW };
    state.persist();
    expect(repository.read()).toEqual({ heater: { kw: 2, observedAtMs: NOW - 1000 } });

    readable = true;
    peaks.charger = { kw: 7.5, observedAtMs: NOW };
    state.persist();

    // Neither side is discarded: the heater was never observed this run, the
    // charger was only observed this run.
    expect(repository.read()).toEqual({
      heater: { kw: 2, observedAtMs: NOW - 1000 },
      charger: { kw: 7.5, observedAtMs: NOW },
    });
  });

  it('writes every change through, with nothing held back for a restart to lose', () => {
    const state = buildState();
    state.load();

    peaks.heater = { kw: 2, observedAtMs: NOW };
    state.persist();
    expect(repository.read()).toEqual({ heater: { kw: 2, observedAtMs: NOW } });

    peaks.heater = { kw: 3, observedAtMs: NOW + 10_000 };
    state.persist();
    expect(repository.read()).toEqual({ heater: { kw: 3, observedAtMs: NOW + 10_000 } });
  });

  it('re-anchors a steady device in the store, not only in memory', () => {
    // The policy moves a matched anchor at most once per re-anchor interval, so
    // that is the step replayed here.
    const state = buildState();
    state.load();
    peaks.heater = { kw: 2, observedAtMs: NOW };
    state.persist();

    vi.setSystemTime(NOW + PEAK_REANCHOR_INTERVAL_MS);
    peaks.heater = { kw: 2, observedAtMs: NOW + PEAK_REANCHOR_INTERVAL_MS };
    state.persist();

    expect(repository.read()).toEqual({ heater: { kw: 2, observedAtMs: NOW + PEAK_REANCHOR_INTERVAL_MS } });
  });

  it('carries a peak whose write threw into the next write', () => {
    let failWrite = true;
    const flaky: LearnedPowerPeakStore = {
      ...store,
      write: (next) => {
        if (failWrite) throw new Error('transient write failure');
        repository.write(next);
      },
    };
    const state = buildState(() => flaky);
    state.load();

    peaks.heater = { kw: 2, observedAtMs: NOW };
    state.persist();
    expect(repository.read()).toEqual({});

    failWrite = false;
    peaks.charger = { kw: 7, observedAtMs: NOW };
    state.persist();

    expect(repository.read()).toEqual({
      heater: { kw: 2, observedAtMs: NOW },
      charger: { kw: 7, observedAtMs: NOW },
    });
  });

  it('drops a peak whose window has closed from the store on the way out', () => {
    const state = buildState();
    state.load();
    peaks.stale = { kw: 1, observedAtMs: NOW - PEAK_WINDOW_MS - 1 };
    peaks.heater = { kw: 2, observedAtMs: NOW };

    state.persist();

    expect(repository.read()).toEqual({ heater: { kw: 2, observedAtMs: NOW } });
  });

  it('rewrites only the device whose peak moved', () => {
    const state = buildState();
    state.load();
    peaks.heater = { kw: 2, observedAtMs: NOW };
    peaks.charger = { kw: 7, observedAtMs: NOW };
    state.persist();
    const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

    peaks.heater = { kw: 2.5, observedAtMs: NOW + 1000 };
    state.persist();

    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n - changesBefore).toBe(1);
    expect(rowCount(db)).toBe(2);
  });
});

describe('the legacy learned-peaks import', () => {
  const rig = () => {
    const settings = installSettings();
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    return { settings, db, repository: createLearnedPowerPeakRepository(db) };
  };

  it('imports the blob into an empty store and retires the key; a second boot has nothing to do', () => {
    const { settings, repository } = rig();
    settings.set(DEVICE_POWER_PEAKS, { heater: { kw: 2, observedAtMs: NOW - 1000 }, bad: { kw: 'x' } });

    expect(createImportingLearnedPowerPeakStore(settings, repository).settleLegacyImport()).toBe('settled');

    expect(repository.read()).toEqual({ heater: { kw: 2, observedAtMs: NOW - 1000 } });
    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
    const get = vi.spyOn(settings, 'get');
    createImportingLearnedPowerPeakStore(settings, repository).settleLegacyImport();
    expect(get).not.toHaveBeenCalled();
  });

  it('merges the blob under what the store already learned', () => {
    // A deferred import still lets the store fill from an empty boot.
    const { settings, repository } = rig();
    repository.write({ heater: { kw: 3, observedAtMs: NOW } });
    settings.set(DEVICE_POWER_PEAKS, {
      heater: { kw: 2, observedAtMs: NOW - 1000 },
      charger: { kw: 7, observedAtMs: NOW - 1000 },
    });

    createImportingLearnedPowerPeakStore(settings, repository).settleLegacyImport();

    expect(repository.read()).toEqual({
      heater: { kw: 3, observedAtMs: NOW },
      charger: { kw: 7, observedAtMs: NOW - 1000 },
    });
  });

  it('keeps a blob it can read nothing from for the next boot, and does not retry it this run', () => {
    const { settings, repository } = rig();
    settings.set(DEVICE_POWER_PEAKS, { heater: { kw: 'x' } });

    const store = createImportingLearnedPowerPeakStore(settings, repository);
    expect(store.settleLegacyImport()).toBe('settled');

    expect(settings.get(DEVICE_POWER_PEAKS)).toEqual({ heater: { kw: 'x' } });
    expect(repository.hasImportedLegacy()).toBe(false);
    const get = vi.spyOn(settings, 'get');
    expect(store.settleLegacyImport()).toBe('settled');
    expect(get).not.toHaveBeenCalled();
  });

  it('imports an empty record as nothing, since everything aging out is a real answer', () => {
    const { settings, repository } = rig();
    settings.set(DEVICE_POWER_PEAKS, {});

    createImportingLearnedPowerPeakStore(settings, repository).settleLegacyImport();

    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
    expect(repository.hasImportedLegacy()).toBe(true);
  });

  it('keeps a blob owed while the key list or its read fails, and imports it once both answer', () => {
    const { settings, repository } = rig();
    settings.set(DEVICE_POWER_PEAKS, { heater: { kw: 2, observedAtMs: NOW - 1000 } });
    const getKeys = vi.spyOn(settings, 'getKeys').mockImplementation(() => { throw new Error('sdk unavailable'); });
    const capture = captureLogger();
    onTestFinished(() => capture.restore());

    const store = createImportingLearnedPowerPeakStore(settings, repository);
    expect(store.settleLegacyImport()).toBe('pending');
    expect(store.settleLegacyImport()).toBe('pending');
    getKeys.mockRestore();
    const get = vi.spyOn(settings, 'get').mockImplementationOnce(() => {
      throw new Error('transient settings read');
    });
    expect(store.settleLegacyImport()).toBe('pending');
    get.mockRestore();

    expect(repository.read()).toEqual({});
    expect(settings.get(DEVICE_POWER_PEAKS)).not.toBeNull();
    expect(store.settleLegacyImport()).toBe('settled');
    expect(repository.read()).toEqual({ heater: { kw: 2, observedAtMs: NOW - 1000 } });
    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
    // Each deferral is said once, however often the retry meets it.
    expect(capture.findEvents('legacy_learned_power_peaks_import_deferred').map((line) => line.reason))
      .toEqual(['key_list_unreadable', 'read_threw']);
    expect(capture.findEvent('legacy_learned_power_peaks_imported')).toBeDefined();
  });
});

describe('a legacy learned-peaks import the upgrade boot could not finish', () => {
  let db: UserdataDatabase;
  let settings: MockSettings;
  let peaks: LearnedPeaksByDeviceId;
  let timers: TimerRegistry;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    db = openUserdataDatabase(IN_MEMORY_DATABASE);
    settings = installSettings();
    settings.set(DEVICE_POWER_PEAKS, {
      heater: { kw: 2, observedAtMs: NOW - 1000 },
      charger: { kw: 5, observedAtMs: NOW - 1000 },
    });
    peaks = {};
    timers = new TimerRegistry();
  });

  afterEach(() => {
    timers.clearAll();
    db.close();
    vi.useRealTimers();
  });

  /**
   * Boot with the key list answering nothing, as the SDK does on a transient
   * miss, over a store whose reads fail while `failReads` is set.
   */
  const bootWithUnreadableKeyList = () => {
    const getKeys = vi.spyOn(settings, 'getKeys').mockImplementation(() => { throw new Error('sdk unavailable'); });
    const repository = createLearnedPowerPeakRepository(db);
    const importing = createImportingLearnedPowerPeakStore(settings, repository);
    const reads = { fail: false };
    const store: LearnedPowerPeakStore = {
      ...importing,
      read: () => {
        if (reads.fail) throw new Error('transient read failure');
        return importing.read();
      },
    };
    const state = createLearnedPowerPeakState({
      getStructuredLogger: () => testLogger,
      getStore: () => store,
      getPeaks: () => peaks,
      timers,
    });
    state.load();
    return { state, repository, reads, heal: () => getKeys.mockRestore() };
  };

  it('is retried within the minute, and the peaks of the devices that are off reach the ladder', () => {
    const { repository, heal } = bootWithUnreadableKeyList();
    expect(peaks).toEqual({});

    heal();
    vi.advanceTimersByTime(60_000);

    expect(peaks).toEqual({
      heater: { kw: 2, observedAtMs: NOW - 1000 },
      charger: { kw: 5, observedAtMs: NOW - 1000 },
    });
    expect(repository.read()).toEqual(peaks);
    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
  });

  it('keeps retrying while the key list stays unreadable', () => {
    const { heal } = bootWithUnreadableKeyList();

    vi.advanceTimersByTime(5 * 60_000);
    expect(peaks).toEqual({});

    heal();
    vi.advanceTimersByTime(60_000);
    expect(peaks.heater).toEqual({ kw: 2, observedAtMs: NOW - 1000 });
  });

  it('keeps reading in an import whose first read after it failed, with nothing written meanwhile', () => {
    const { repository, reads, heal } = bootWithUnreadableKeyList();
    heal();
    reads.fail = true;
    vi.advanceTimersByTime(60_000);
    // Imported and retired, but not yet read in.
    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
    expect(peaks).toEqual({});

    reads.fail = false;
    vi.advanceTimersByTime(60_000);

    expect(peaks).toEqual({
      heater: { kw: 2, observedAtMs: NOW - 1000 },
      charger: { kw: 5, observedAtMs: NOW - 1000 },
    });
    expect(repository.read()).toEqual(peaks);
    expect(timers.has('learnedPeakLegacyImportRetry')).toBe(false);
  });

  it('reads in and writes through an import a write landed while the read failed, with the home idle after', () => {
    // The minute retry is already queued from the boot when the write lands
    // the import; that one retry must carry the read and the waiting write.
    const { state, repository, reads, heal } = bootWithUnreadableKeyList();
    heal();
    reads.fail = true;
    peaks.charger = { kw: 7.5, observedAtMs: NOW };
    state.persist();
    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
    expect(peaks).toEqual({ charger: { kw: 7.5, observedAtMs: NOW } });

    reads.fail = false;
    vi.advanceTimersByTime(60_000);

    const expected = {
      heater: { kw: 2, observedAtMs: NOW - 1000 },
      charger: { kw: 7.5, observedAtMs: NOW },
    };
    expect(peaks).toEqual(expected);
    expect(repository.read()).toEqual(expected);
    expect(timers.has('learnedPeakLegacyImportRetry')).toBe(false);
  });

  it('keeps the peaks learned while it was owed, and the next write keeps what it imported', () => {
    const { state, repository, heal } = bootWithUnreadableKeyList();
    // Written through while the blob is owed: the import goes under it.
    peaks.charger = { kw: 7, observedAtMs: NOW };
    state.persist();
    expect(repository.read()).toEqual({ charger: { kw: 7, observedAtMs: NOW } });

    // The write itself retries the import, and reads in what it brought before
    // writing: a write makes the store hold exactly the record.
    heal();
    peaks.charger = { kw: 7.5, observedAtMs: NOW + 1000 };
    state.persist();

    const expected = {
      heater: { kw: 2, observedAtMs: NOW - 1000 },
      charger: { kw: 7.5, observedAtMs: NOW + 1000 },
    };
    expect(repository.read()).toEqual(expected);
    expect(peaks).toEqual(expected);
    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
    expect(timers.has('learnedPeakLegacyImportRetry')).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(timers.has('learnedPeakLegacyImportRetry')).toBe(false);
    expect(repository.read()).toEqual(expected);
  });
});
