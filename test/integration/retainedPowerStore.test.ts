import {
  createRetainedPowerStore,
  RETAINED_POWER_MAX_AGE_MS,
  RETAINED_POWER_TOUCH_INTERVAL_MS,
  type RetainedPowerReading,
  type RetainedPowerState,
} from '../../lib/device/retainedPowerStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-23T10:00:00.000Z');

const reading: RetainedPowerReading = { measuredPowerKw: 3, observedAtMs: T0 };
const anchor = { kwh: 10.05, observedAtMs: T0 };

const state = (
  readings: Array<[string, RetainedPowerReading]>,
  anchors: Array<[string, { kwh: number; observedAtMs: number }]> = [],
): RetainedPowerState => ({ readings: new Map(readings), meterAnchors: new Map(anchors) });
const present = (...ids: string[]): ReadonlySet<string> => new Set(ids);

const savedAtOf = (db: UserdataDatabase, table: string, deviceId: string): number | undefined => (
  (db.prepare(`SELECT saved_at_ms FROM ${table} WHERE device_id = ?`).get(deviceId) as
    { saved_at_ms: number } | undefined)?.saved_at_ms
);

describe('retained power store', () => {
  let db: UserdataDatabase;

  beforeEach(() => {
    db = openUserdataDatabase(IN_MEMORY_DATABASE);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips readings and meter anchors to a fresh store on the same database', () => {
    createRetainedPowerStore(db).save(
      state([['plug-1', reading], ['heater-1', { measuredPowerKw: 0 }]], [['plug-1', anchor]]),
      present('plug-1', 'heater-1'),
      T0,
    );

    const restored = createRetainedPowerStore(db).load(T0 + DAY_MS);

    expect(restored.readings.get('plug-1')).toEqual(reading);
    expect(restored.readings.get('heater-1')).toEqual({ measuredPowerKw: 0 });
    expect(restored.meterAnchors.get('plug-1')).toEqual(anchor);
  });

  it('keeps a device absent from a later save: one cycle without it is not its removal', () => {
    const store = createRetainedPowerStore(db);
    store.save(state([['plug-1', reading]], [['plug-1', anchor]]), present('plug-1'), T0);
    store.save(state([]), present(), T0 + 60_000);

    const restored = createRetainedPowerStore(db).load(T0 + 120_000);
    expect(restored.readings.get('plug-1')).toEqual(reading);
    expect(restored.meterAnchors.get('plug-1')).toEqual(anchor);
  });

  it('deletes the rows of a PRESENT device that no longer retains a reading or an anchor', () => {
    // E.g. a meter device that now reports `measure_power`: its anchor is gone
    // in memory, and restoring the old one after a restart would pair it with a
    // weeks-old observation.
    const store = createRetainedPowerStore(db);
    store.save(state([['plug-1', reading]], [['plug-1', anchor]]), present('plug-1'), T0);
    store.save(state([]), present('plug-1'), T0 + 60_000);

    const restored = createRetainedPowerStore(db).load(T0 + 120_000);
    expect(restored.readings.has('plug-1')).toBe(false);
    expect(restored.meterAnchors.has('plug-1')).toBe(false);
  });

  it('writes an unchanged reading only when its row is due a re-save', () => {
    const store = createRetainedPowerStore(db);
    store.save(state([['plug-1', reading]]), present('plug-1'), T0);
    store.save(state([['plug-1', reading]]), present('plug-1'), T0 + 60_000);
    expect(savedAtOf(db, 'device_power_reading', 'plug-1')).toBe(T0);

    store.save(state([['plug-1', reading]]), present('plug-1'), T0 + RETAINED_POWER_TOUCH_INTERVAL_MS);
    expect(savedAtOf(db, 'device_power_reading', 'plug-1')).toBe(T0 + RETAINED_POWER_TOUCH_INTERVAL_MS);
  });

  it('keeps a device whose reading never changes, and prunes one not seen for a month', () => {
    const store = createRetainedPowerStore(db);
    store.save(
      state([['idle-heater', { measuredPowerKw: 0 }], ['removed-plug', reading]], [['removed-plug', anchor]]),
      present('idle-heater', 'removed-plug'),
      T0,
    );
    for (let day = 1; day <= 35; day += 1) {
      store.save(state([['idle-heater', { measuredPowerKw: 0 }]]), present('idle-heater'), T0 + day * DAY_MS);
    }

    const restored = createRetainedPowerStore(db).load(T0 + RETAINED_POWER_MAX_AGE_MS + 5 * DAY_MS);
    expect(restored.readings.has('idle-heater')).toBe(true);
    expect(restored.readings.has('removed-plug')).toBe(false);
    expect(restored.meterAnchors.has('removed-plug')).toBe(false);
  });

  it('retries a write whose transaction rolled back, instead of believing it landed', () => {
    const store = createRetainedPowerStore(db);
    store.save(state([['plug-1', reading]]), present('plug-1'), T0);
    const next = { measuredPowerKw: 1, observedAtMs: T0 + 60_000 };
    const exec = vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    expect(() => store.save(state([['plug-1', next]]), present('plug-1'), T0 + 60_000)).toThrow('disk I/O error');
    exec.mockRestore();

    store.save(state([['plug-1', next]]), present('plug-1'), T0 + 120_000);
    expect(createRetainedPowerStore(db).load(T0 + 180_000).readings.get('plug-1')).toEqual(next);
  });

  it('quarantines a row that does not parse, without costing the rows around it', () => {
    createRetainedPowerStore(db).save(state([['plug-1', reading]]), present('plug-1'), T0);
    db.prepare('INSERT INTO device_power_reading (device_id, reading_json, saved_at_ms) VALUES (?, ?, ?)')
      .run('broken', '{"measuredPowerKw":-1}', T0);
    db.prepare('INSERT INTO device_power_reading (device_id, reading_json, saved_at_ms) VALUES (?, ?, ?)')
      .run('garbage', 'not json', T0);

    const restored = createRetainedPowerStore(db).load(T0 + 60_000);

    expect([...restored.readings.keys()]).toEqual(['plug-1']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM device_power_reading').get()).toEqual({ n: 1 });
  });
});
