import { createWeatherHistoryStore, importLegacyWeatherHistory } from '../../lib/weather/weatherHistoryStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { WEATHER_HISTORY_STATE } from '../../lib/utils/settingsKeys';
import type { WeatherDailyRecord, WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import { MockSettings } from '../mocks/homey';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createWeatherHistoryStore(db) };
};

const day = (dateKey: string, tempMeanC: number, extra: Partial<WeatherDailyRecord> = {}): WeatherDailyRecord => ({
  dateKey,
  tempMeanC,
  tempMinC: tempMeanC - 3,
  tempMaxC: tempMeanC + 3,
  tempSampleCount: 24,
  quality: {
    partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false,
  },
  ...extra,
});

const STATE: WeatherHistoryState = {
  records: [day('2026-03-01', -2, { kwhTotal: 55 }), day('2026-03-02', 1)],
  accumulators: { '2026-03-03': { sumC: 10, count: 2, minC: 4, maxC: 6, kwhTotal: 3 } as never },
  backfilledDeviceId: 'out-1',
  backfillVersion: 2,
  meterScopeSignature: 'source:homey_energy|main:meter-a',
  budgetPressure: { kwh: 3.5, throughDateKey: '2026-03-02' },
};

const rowCounts = (db: ReturnType<typeof open>['db']) => ({
  days: (db.prepare('SELECT COUNT(*) AS n FROM weather_history_days').get() as { n: number }).n,
  fields: (db.prepare('SELECT COUNT(*) AS n FROM weather_history_fields').get() as { n: number }).n,
});
const totalChanges = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

describe('weatherHistoryStore', () => {
  it('answers null while empty, and round-trips a state: one row per day, one per other field', () => {
    const { db, store } = open();
    expect(store.read()).toBeNull();
    store.write(STATE);
    expect(store.read()).toEqual(STATE);
    expect(rowCounts(db)).toEqual({ days: 2, fields: 5 });
  });

  // The point of the move: a persist touches the day and the fields that
  // changed, not the two years of records around them.
  it('writes only the rows that changed, and deletes the ones that went', () => {
    const { db, store } = open();
    store.write(STATE);
    const changes = totalChanges(db);
    store.write({
      ...STATE,
      records: [STATE.records[0], day('2026-03-03', 4)],
      accumulators: {},
      backfillVersion: 3,
    });
    // One day upserted, one deleted; `accumulators` rewritten, `backfillVersion` rewritten.
    expect(totalChanges(db) - changes).toBe(4);
    expect(store.read()).toEqual({
      ...STATE,
      records: [STATE.records[0], day('2026-03-03', 4)],
      accumulators: {},
      backfillVersion: 3,
    });
  });

  it('an unchanged state costs no rows, whether by reference or by value', () => {
    const { db, store } = open();
    store.write(STATE);
    const changes = totalChanges(db);
    store.write(STATE);
    store.write(JSON.parse(JSON.stringify(STATE)) as WeatherHistoryState);
    expect(totalChanges(db) - changes).toBe(0);
  });

  // A fresh store (a boot) diffs its first write against the rows on disk,
  // read or not, so it can delete what the caller dropped.
  it('diffs the first write of a fresh store against the rows on disk', () => {
    const { db, store } = open();
    store.write(STATE);
    const blind = createWeatherHistoryStore(db);
    blind.write({ records: [STATE.records[1]] });
    expect(blind.read()).toEqual({ records: [STATE.records[1]] });
    expect(rowCounts(db)).toEqual({ days: 1, fields: 0 });
  });

  it('quarantines a row that does not parse and keeps the rest', () => {
    const { db, store } = open();
    store.write(STATE);
    db.prepare('UPDATE weather_history_days SET record_json = ? WHERE date_key = ?').run('{not json', '2026-03-01');
    db.prepare("UPDATE weather_history_fields SET value_json = ? WHERE key = 'backfillVersion'").run('nope');
    expect(store.read()).toEqual({ ...STATE, records: [STATE.records[1]], backfillVersion: undefined });
    expect(store.read()).not.toHaveProperty('backfillVersion');
    // The bad rows are gone, not lingering to be re-logged on every boot.
    expect(rowCounts(db)).toEqual({ days: 1, fields: 4 });
  });

  it('a write that throws inside its transaction leaves the previous rows intact', () => {
    const { db, store } = open();
    store.write(STATE);
    const poisoned: WeatherHistoryState = { ...STATE, records: [...STATE.records, day('2026-03-03', 2)] };
    const upsert = db.prepare('SELECT 1');
    vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => store.write(poisoned)).toThrow();
    void upsert;
    expect(store.read()).toEqual(STATE);
  });
});

describe('importLegacyWeatherHistory', () => {
  const rig = () => {
    const settings = new MockSettings();
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the blob into an empty store and retires the key; a second boot has nothing to do', () => {
    const { settings, store } = rig();
    settings.set(WEATHER_HISTORY_STATE, STATE);
    importLegacyWeatherHistory(settings, store);
    expect(store.read()).toEqual(STATE);
    expect(settings.get(WEATHER_HISTORY_STATE)).toBeNull();
    // A second boot has nothing left to do, and reads nothing: an install
    // that has imported (or never had the key) is not a deferral every boot.
    const get = vi.spyOn(settings, 'get');
    importLegacyWeatherHistory(settings, store);
    expect(get).not.toHaveBeenCalled();
    expect(store.read()).toEqual(STATE);
  });

  // A boot whose import deferred lets the collector write the days since
  // (its grace window ends in an empty write); the next boot's import keeps
  // both, with the store's newer days and every store-owned field winning
  // and the blob filling in only the days the store lacks.
  it('imports the blob under what the store already holds: the store wins, the blob fills in', () => {
    const { settings, store } = rig();
    const newerDay = day('2026-03-02', 7);
    store.write({
      records: [newerDay, day('2026-04-01', 9)],
      accumulators: { '2026-04-02': { sumC: 1, count: 1, minC: 1, maxC: 1 } as never },
      meterScopeSignature: 'source:flow',
    });
    settings.set(WEATHER_HISTORY_STATE, STATE);
    importLegacyWeatherHistory(settings, store);
    expect(store.read()).toEqual({
      records: [STATE.records[0], newerDay, day('2026-04-01', 9)],
      accumulators: { '2026-04-02': { sumC: 1, count: 1, minC: 1, maxC: 1 } },
      meterScopeSignature: 'source:flow',
      backfilledDeviceId: 'out-1',
      backfillVersion: 2,
      budgetPressure: STATE.budgetPressure,
    });
    expect(settings.get(WEATHER_HISTORY_STATE)).toBeNull();
  });

  it('imports what normalises and drops what does not, the way the collector always read it', () => {
    const { settings, store } = rig();
    settings.set(WEATHER_HISTORY_STATE, {
      records: [STATE.records[0], { dateKey: '2026-03-02', tempMeanC: 'junk' }],
      budgetPressure: { kwh: Number.NaN, throughDateKey: 'd' },
    });
    importLegacyWeatherHistory(settings, store);
    expect(store.read()).toEqual({ records: [STATE.records[0]] });
    expect(settings.get(WEATHER_HISTORY_STATE)).toBeNull();
  });

  // One transient must never cost two years of history: a suspect read
  // leaves the key where it is for the next boot.
  it('defers on a suspect read, a value with no history in it, or a store that cannot answer', () => {
    const { settings, store } = rig();
    settings.set(WEATHER_HISTORY_STATE, 'garbage');
    importLegacyWeatherHistory(settings, store);
    expect(settings.get(WEATHER_HISTORY_STATE)).toBe('garbage');
    settings.set(WEATHER_HISTORY_STATE, STATE);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === WEATHER_HISTORY_STATE ? undefined : originalGet(key)));
    importLegacyWeatherHistory(settings, store);
    get.mockRestore();
    const write = vi.spyOn(store, 'write').mockImplementation(() => { throw new Error('disk full'); });
    importLegacyWeatherHistory(settings, store);
    write.mockRestore();
    expect(store.read()).toBeNull();
    expect(originalGet(WEATHER_HISTORY_STATE)).toEqual(STATE);
    importLegacyWeatherHistory(settings, store);
    expect(store.read()).toEqual(STATE);
    expect(settings.get(WEATHER_HISTORY_STATE)).toBeNull();
  });
});
