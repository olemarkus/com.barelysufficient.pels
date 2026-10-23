import { createLearnedPowerPeakState } from '../../lib/device/learnedPowerPeakState';
import {
  createLearnedPowerPeakRepository,
  importLegacyLearnedPowerPeaks,
  type LearnedPowerPeakRepository,
} from '../../lib/device/learnedPowerPeakStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { DEVICE_POWER_PEAKS } from '../../lib/utils/settingsKeys';
import {
  PEAK_WINDOW_MS,
  PEAK_REANCHOR_INTERVAL_MS,
  type LearnedPeaksByDeviceId,
} from '../../lib/device/devicePowerPeak';
import { MockSettings } from '../mocks/homey';
import { testLogger } from '../utils/testLogger';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

const rowCount = (db: UserdataDatabase): number => (
  (db.prepare('SELECT COUNT(*) AS n FROM device_power_peaks').get() as { n: number }).n
);

/**
 * The write-through layer for the learned peaks, over the real repository on an
 * in-memory userdata database. The peak POLICY is unit-tested in
 * `devicePowerPeak.test.ts`; what is under test here is when a peak reaches the
 * store, and when it must not.
 */
describe('learned power peak persistence', () => {
  let db: UserdataDatabase;
  let repository: LearnedPowerPeakRepository;
  let peaks: LearnedPeaksByDeviceId;

  const buildState = (getRepository: () => LearnedPowerPeakRepository = () => repository) => (
    createLearnedPowerPeakState({
      getStructuredLogger: () => testLogger,
      getRepository,
      getPeaks: () => peaks,
    })
  );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    db = openUserdataDatabase(IN_MEMORY_DATABASE);
    repository = createLearnedPowerPeakRepository(db);
    peaks = {};
  });

  afterEach(() => {
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
    const flaky: LearnedPowerPeakRepository = {
      ...repository,
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
    const flaky: LearnedPowerPeakRepository = {
      ...repository,
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

describe('importLegacyLearnedPowerPeaks', () => {
  const rig = () => {
    const settings = new MockSettings();
    // A real install never has an empty key list here: the boot migrations set
    // their markers first.
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    return { settings, db, repository: createLearnedPowerPeakRepository(db) };
  };

  it('imports the blob into an empty store and retires the key; a second boot has nothing to do', () => {
    const { settings, repository } = rig();
    settings.set(DEVICE_POWER_PEAKS, { heater: { kw: 2, observedAtMs: NOW - 1000 }, bad: { kw: 'x' } });

    importLegacyLearnedPowerPeaks(settings, repository);

    expect(repository.read()).toEqual({ heater: { kw: 2, observedAtMs: NOW - 1000 } });
    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
    const get = vi.spyOn(settings, 'get');
    importLegacyLearnedPowerPeaks(settings, repository);
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

    importLegacyLearnedPowerPeaks(settings, repository);

    expect(repository.read()).toEqual({
      heater: { kw: 3, observedAtMs: NOW },
      charger: { kw: 7, observedAtMs: NOW - 1000 },
    });
  });

  it('keeps a blob it can read nothing from for the next boot', () => {
    const { settings, repository } = rig();
    settings.set(DEVICE_POWER_PEAKS, { heater: { kw: 'x' } });

    importLegacyLearnedPowerPeaks(settings, repository);

    expect(settings.get(DEVICE_POWER_PEAKS)).toEqual({ heater: { kw: 'x' } });
    expect(repository.hasImportedLegacy()).toBe(false);
  });

  it('imports an empty record as nothing, since everything aging out is a real answer', () => {
    const { settings, repository } = rig();
    settings.set(DEVICE_POWER_PEAKS, {});

    importLegacyLearnedPowerPeaks(settings, repository);

    expect(settings.get(DEVICE_POWER_PEAKS)).toBeNull();
    expect(repository.hasImportedLegacy()).toBe(true);
  });
});
