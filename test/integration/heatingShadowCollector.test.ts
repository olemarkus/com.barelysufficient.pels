// Main's passive heating observations (`lib/diagnostics/heatingShadowCollector.ts`)
// in their own userdata store (`heatingShadowStore.ts`), apart from the power
// tracker: collected at meter ingest, checkpointed once a minute, read by the
// daily report.
import { describe, expect, it, vi } from 'vitest';
import { HeatingShadowCollector } from '../../lib/diagnostics/heatingShadowCollector';
import { recordHeatingShadow } from '../../lib/diagnostics/heatingShadow';
import {
  createDeferredHeatingShadowStore, createHeatingShadowStore, type HeatingShadowStore,
} from '../../lib/diagnostics/heatingShadowStore';
import type { HeatingShadowDevice } from '../../lib/diagnostics/heatingShadowTypes';
import { createTrackerStore } from '../../lib/power/trackerStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { partialDouble } from '../helpers/partialDouble';

const START = Date.UTC(2026, 10, 2);
const MINUTE_MS = 60_000;
const TIME_ZONE = 'Europe/Oslo';

function device(minute: number, managed = true): DeviceSurfaces {
  const powerKw = minute < 15 ? 1 : 0;
  return partialDouble<DeviceSurfaces>({
    id: 'room', name: 'Room', deviceType: 'temperature', available: true, managed,
    measuredPowerKw: powerKw, measuredPowerIsDirectMeasurement: true,
    measuredPowerObservedAtMs: START - 24 * 3_600_000,
    binaryControl: { on: true },
    temperature: { currentTemperature: 20 + minute / 100,
      target: { id: 'target_temperature', value: 21, unit: '°C' } },
  });
}

const collectorOn = (
  store: HeatingShadowStore, devices: () => DeviceSurfaces[], outdoorC: () => number | undefined = () => undefined,
  timeZone = TIME_ZONE,
) => new HeatingShadowCollector(store, devices, () => 'heating', () => timeZone, outdoorC);

/** Half an hour of five-minute samples: a quarter hour heating at 1 kW, then one idle. */
function collect(db: UserdataDatabase): HeatingShadowCollector {
  let minute = 0;
  const collector = collectorOn(createHeatingShadowStore(db), () => [device(minute)],
    () => (minute < 15 ? -2 : undefined));
  for (; minute <= 30; minute += 5) collector.record(START + minute * MINUTE_MS);
  return collector;
}

const totalChanges = (db: UserdataDatabase): number => (
  (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
);
const rowCount = (db: UserdataDatabase, sql: string): number => (db.prepare(sql).get() as { count: number }).count;

describe('Main heating observations in their own store', () => {
  it('records chronological heating and idle evidence apart from the power tracker', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const collector = collect(db);
    const day = createHeatingShadowStore(db).load()!.days[0]!;
    expect(day.devices.room!.intervals).toHaveLength(2);
    expect(day.devices.room!.intervals[0]!.inputKWh).toBeCloseTo(0.25);
    expect(day.devices.room!.intervals[1]!.inputKWh).toBe(0);
    expect(day.outdoor).toMatchObject([
      { state: 'available', temperatureC: -2 }, { state: 'unavailable' },
    ]);
    expect(collector.readDaily(START + 24 * 3_600_000)?.title).toBe('Daily heating observations');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'power_tracker%'").all()).toEqual([]);
    db.close();
  });

  it('continues the stored chronology after a restart and checkpoints only the rows that changed', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    collect(db);
    const store = createDeferredHeatingShadowStore(() => db);
    const restarted = collectorOn(store, () => [device(35)]);
    const before = totalChanges(db);
    restarted.record(START + 35 * MINUTE_MS);
    // Stable history is separate rows: this checkpoint updates only the open window.
    expect(totalChanges(db) - before).toBe(1);
    const room = store.load()!.days[0]!.devices.room!;
    expect(room.intervals[0]!.inputKWh).toBeCloseTo(0.25);
    expect(room.window!.last.atMs).toBe(START + 35 * MINUTE_MS);
    db.close();
  });

  it('writes at most one checkpoint a minute', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = createHeatingShadowStore(db);
    const save = vi.spyOn(store, 'save');
    const collector = collectorOn(store, () => [device(0)]);
    for (let seconds = 0; seconds <= 120; seconds += 10) collector.record(START + seconds * 1000);
    expect(save.mock.calls.map(([state]) => state.days[0]!.devices.room!.window!.last.atMs))
      .toEqual([START, START + 60_000, START + 120_000]);
    db.close();
  });

  it('quarantines malformed rows together, and collection starts again', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    collect(db);
    db.prepare("UPDATE heating_shadow_rows SET value_json = 'null' WHERE key LIKE '%/interval/%'").run();
    expect(createHeatingShadowStore(db).load()).toBeNull();
    expect(rowCount(db, 'SELECT COUNT(*) AS count FROM heating_shadow_rows')).toBe(0);
    db.close();
  });

  it.each(['orphan', 'timestamp mismatch'])('quarantines %s rows outside the canonical layout', (fault) => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    collect(db);
    if (fault === 'orphan') {
      db.prepare('INSERT INTO heating_shadow_rows (key, value_json) VALUES (?, ?)').run('2026-11-02/unused', 'null');
    } else {
      db.prepare("UPDATE heating_shadow_rows SET key = key || '/mismatch' WHERE key LIKE '%/interval/%'").run();
    }
    expect(createHeatingShadowStore(db).load()).toBeNull();
    db.close();
  });

  it('deletes the observations Test builds kept among the power tracker rows', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const buckets = { '2026-11-02T00:00:00.000Z': 1.25 };
    createTrackerStore(db).save('main', { buckets });
    const insert = db.prepare('INSERT INTO power_tracker_scalars (home_id, key, value_json) VALUES (?, ?, ?)');
    insert.run('main', 'heatingShadow', '{"layoutVersion":1}');
    insert.run('main', 'heatingShadow/2026-11-02/outdoor/1', '{}');
    insert.run('cabin', 'heatingShadow/2026-11-02/outdoor/1', '{}');
    expect(createTrackerStore(db).load('main')).toEqual({ buckets });
    expect(rowCount(db, "SELECT COUNT(*) AS count FROM power_tracker_scalars WHERE key LIKE 'heatingShadow%'"))
      .toBe(0);
    db.close();
  });

  it('excludes indirect power and interrupts evidence when the device becomes unmanaged', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = createHeatingShadowStore(db);
    collectorOn(store, () => [{ ...device(0), measuredPowerIsDirectMeasurement: false }]).record(START);
    expect(store.load()).toBeNull();
    let managed = true;
    const collector = collectorOn(store, () => [device(managed ? 0 : 5, managed)]);
    collector.record(START);
    managed = false;
    collector.record(START + 5 * MINUTE_MS);
    const room = store.load()!.days[0]!.devices.room!;
    expect(room.window).toBeUndefined();
    expect(room.interruptions).toBe(1);
    db.close();
  });

  it('contains collection failures without stopping the meter sample', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = createHeatingShadowStore(db);
    expect(() => collectorOn(store, () => [device(0)], () => undefined, 'invalid/timezone').record(START))
      .not.toThrow();
    expect(() => collectorOn(store, () => { throw new Error('devices unavailable'); }).record(START)).not.toThrow();
    expect(store.load()).toBeNull();
    db.close();
  });

  it('reads a store that failed at boot again at the next checkpoint, and writes nothing before', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const start = Date.UTC(2026, 10, 2, 9);
    const source = (atMs: number): HeatingShadowDevice => ({ id: 'room',
      signal: { temperatureCapability: 'measure_temperature', temperatureRole: 'unclassified',
        targetCapability: 'target_temperature', electricalInput: 'held_reported_direct_power' },
      reading: { atMs, temperatureC: 20, powerKw: 1, targetC: 22, control: 'enabled' },
    });
    const previousDay = recordHeatingShadow(undefined, [source(start - 86_400_000)], start - 86_400_000, -2, TIME_ZONE);
    const earlier = recordHeatingShadow(previousDay, [source(start)], start, -2, TIME_ZONE);
    const real = createHeatingShadowStore(db);
    real.save(recordHeatingShadow(earlier, [source(start + 300_000)], start + 300_000, -2, TIME_ZONE));
    const flaky: HeatingShadowStore = {
      load: vi.fn<HeatingShadowStore['load']>()
        .mockImplementationOnce(() => { throw new Error('disk busy'); })
        .mockImplementation(() => real.load()),
      save: vi.fn<HeatingShadowStore['save']>((state) => real.save(state)),
    };
    const heater = partialDouble<DeviceSurfaces>({ ...device(0), temperature: { currentTemperature: 20,
      target: { id: 'target_temperature', value: 22, unit: '°C' } } });
    const collector = collectorOn(flaky, () => [heater]);
    collector.record(start + 1_800_000);
    expect(flaky.save).not.toHaveBeenCalled();
    collector.record(start + 1_860_000);
    const restored = real.load();
    expect(restored?.days.map((day) => day.dateKey)).toEqual(['2026-11-01', '2026-11-02']);
    const room = restored?.days[1]?.devices.room;
    expect(room?.intervals).toMatchObject([{ startMs: start, endMs: start + 300_000, inputKWh: 1 / 12 }]);
    expect(room?.window?.start.atMs).toBe(start + 1_800_000);
    db.close();
  });

  it('answers the daily report only once the stored observations are read', () => {
    const unreadable: HeatingShadowStore = { load: () => { throw new Error('database closed'); }, save: vi.fn() };
    const collector = collectorOn(unreadable, () => [device(0)]);
    collector.record(START);
    expect(unreadable.save).not.toHaveBeenCalled();
    expect(() => collector.readDaily(START + 24 * 3_600_000)).toThrow('database closed');
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    expect(collectorOn(createHeatingShadowStore(db), () => []).readDaily(START)).toBeUndefined();
    db.close();
  });
});
