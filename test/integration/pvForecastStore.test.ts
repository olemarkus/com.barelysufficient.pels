import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createImportingPvForecastStore,
  createPvForecastStateStore,
  importLegacyPvForecastState,
} from '../../lib/solar/pvForecastStateStore';
import { PvForecastController } from '../../lib/solar/pvForecastController';
import type { PvForecastServiceState } from '../../lib/solar/pvForecastService';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import { PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED } from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

const HOUR_MS = 3_600_000;
const BASE = Date.UTC(2026, 5, 21, 10, 0, 0);
const hourKey = (offset: number): string => String(BASE + offset * HOUR_MS);

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createPvForecastStateStore(db) };
};

const totalChanges = (db: UserdataDatabase): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

// Three recorded hours, irradiance for two of them, one gap-tainted, and the cursor.
const recorded = (): PvForecastServiceState => ({
  history: {
    lastSampleMs: BASE + 2.5 * HOUR_MS,
    lastGenerationW: 900,
    lastNetW: -300,
    hourly: {
      [hourKey(0)]: { kwh: 0.8, coveredMs: HOUR_MS, netMs: HOUR_MS, importMs: 0, exportMs: 600_000 },
      [hourKey(1)]: { kwh: 1.1, coveredMs: HOUR_MS },
      [hourKey(2)]: { kwh: 0.4, coveredMs: 1_800_000 },
    },
    taintedHourStarts: { [hourKey(1)]: true },
  },
  irradianceByHour: { [hourKey(0)]: 520, [hourKey(1)]: 610 },
});

describe('pvForecastStateStore', () => {
  it('answers absent while empty, and round-trips a state', () => {
    const { store } = open();
    expect(store.read()).toEqual({ kind: 'absent' });
    store.write(recorded());
    expect(store.read()).toEqual({ kind: 'loaded', state: recorded() });
  });

  it('a persist rewrites the hour that changed and the cursor, not the history around them', () => {
    const { db, store } = open();
    store.write(recorded());
    const next = recorded();
    next.history.hourly[hourKey(2)] = { kwh: 0.6, coveredMs: 2_400_000 };
    next.history.lastSampleMs = BASE + 2.7 * HOUR_MS;
    const before = totalChanges(db);
    store.write(next);
    expect(totalChanges(db) - before).toBe(2);
    expect(createPvForecastStateStore(db).read()).toEqual({ kind: 'loaded', state: next });
  });

  it('drops a stored hour that could not have been recorded, keeping the rest', () => {
    // A bucket covering more than an hour would forge training evidence.
    const { db, store } = open();
    store.write(recorded());
    db.prepare('UPDATE pv_forecast_hours SET row_json = ? WHERE hour_start = ?')
      .run(JSON.stringify({ bucket: { kwh: 5, coveredMs: 2 * HOUR_MS } }), hourKey(2));
    const read = createPvForecastStateStore(db).read();
    expect(read.kind === 'loaded' && Object.keys(read.state.history.hourly)).toEqual([hourKey(0), hourKey(1)]);
  });
});

describe('importLegacyPvForecastState', () => {
  const rig = () => {
    const settings = new MockSettings();
    // A real install never has an empty key list here: the boot migrations
    // set their markers first.
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the blob, retires it and its written-before marker; a second boot has nothing to do', () => {
    const { settings, store } = rig();
    settings.set(PV_FORECAST_STATE, recorded());
    settings.set(PV_FORECAST_STATE_INITIALIZED, true);
    importLegacyPvForecastState(settings, store);
    expect(store.read()).toEqual({ kind: 'loaded', state: recorded() });
    expect(settings.get(PV_FORECAST_STATE)).toBeNull();
    expect(settings.get(PV_FORECAST_STATE_INITIALIZED)).toBeNull();

    // A key that comes back (an unset that failed) never imports twice.
    settings.set(PV_FORECAST_STATE, { history: { hourly: { [hourKey(9)]: { kwh: 1, coveredMs: HOUR_MS } } } });
    importLegacyPvForecastState(settings, store);
    expect(store.read()).toEqual({ kind: 'loaded', state: recorded() });
  });

  it('merges the blob under what the store recorded since a deferred import', () => {
    const { settings, store } = rig();
    const since: PvForecastServiceState = {
      history: {
        lastSampleMs: BASE + 5.5 * HOUR_MS,
        hourly: { [hourKey(2)]: { kwh: 0.9, coveredMs: HOUR_MS }, [hourKey(5)]: { kwh: 0.2, coveredMs: 1_800_000 } },
      },
      irradianceByHour: { [hourKey(5)]: 300 },
    };
    store.write(since);
    settings.set(PV_FORECAST_STATE, recorded());
    importLegacyPvForecastState(settings, store);

    const read = store.read();
    if (read.kind !== 'loaded') throw new Error('expected a loaded store');
    // The store's hours and cursor win; the blob fills the hours it lacks.
    expect(read.state.history.hourly[hourKey(2)]).toEqual({ kwh: 0.9, coveredMs: HOUR_MS });
    expect(read.state.history.hourly[hourKey(0)]).toEqual(recorded().history.hourly[hourKey(0)]);
    expect(read.state.history.lastSampleMs).toBe(BASE + 5.5 * HOUR_MS);
    expect(read.state.irradianceByHour).toEqual({ [hourKey(0)]: 520, [hourKey(1)]: 610, [hourKey(5)]: 300 });
  });

  it('keeps a blob that vouches for no history, and imports nothing from it', () => {
    const { settings, store } = rig();
    settings.set(PV_FORECAST_STATE, { history: 'junk' });
    settings.set(PV_FORECAST_STATE_INITIALIZED, true);
    importLegacyPvForecastState(settings, store);
    expect(store.read()).toEqual({ kind: 'absent' });
    expect(settings.get(PV_FORECAST_STATE)).toEqual({ history: 'junk' });
    expect(settings.get(PV_FORECAST_STATE_INITIALIZED)).toBe(true);
  });
});

describe('createImportingPvForecastStore', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The upgrade boot: the blob is listed but its first read misses, so the
  // import defers. The controller must not trust the empty store for the whole
  // uptime; the next persist tick imports the blob and merges it in.
  it('answers unreadable while the blob is still owed, and the controller recovers it on the next tick', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ hourly: { time: [], shortwave_radiation: [] } }) })));
    const settings = new MockSettings();
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    settings.set(PV_FORECAST_STATE, recorded());
    const get = settings.get.bind(settings);
    // The import at construction and the controller's boot read both miss.
    let misses = 2;
    vi.spyOn(settings, 'get').mockImplementation((key: string) => {
      if (key === PV_FORECAST_STATE && misses > 0) {
        misses -= 1;
        return undefined;
      }
      return get(key);
    });
    const controller = new PvForecastController({
      store: createImportingPvForecastStore(settings, createPvForecastStateStore(openUserdataDatabase(IN_MEMORY_DATABASE))),
      userAgent: 'pels-test',
      getNowMs: () => Date.now(),
      readCoordinates: async () => ({ kind: 'unavailable', outcome: 'no_location' }),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(Object.keys(controller.service.getState().history.hourly)).toHaveLength(0);

    controller.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(Object.keys(controller.service.getState().history.hourly)).toEqual(Object.keys(recorded().history.hourly));
    expect(settings.get(PV_FORECAST_STATE)).toBeNull();
    controller.stop();
  });
});
