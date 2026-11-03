import { describe, expect, it } from 'vitest';
import { recordHeatingShadowFromSnapshot } from '../../lib/diagnostics/heatingShadowIngest';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { readHeatingShadowDaily } from '../../lib/diagnostics/heatingShadowReport';
import { isPlausiblePowerTrackerState, salvagePowerTrackerState } from '../../lib/power/trackerStateGuards';
import { createTrackerStore } from '../../lib/power/trackerStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
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

function collect(managed = true): PowerTrackerState {
  let state: PowerTrackerState = { buckets: { '2026-11-02T00:00:00.000Z': 1.25 } };
  for (let minute = 0; minute <= 30; minute += 5) {
    state = recordHeatingShadowFromSnapshot(state, [device(minute, managed)], START + minute * MINUTE_MS,
      minute < 15 ? -2 : undefined, () => 'heating', TIME_ZONE);
  }
  return state;
}

describe('meter-ingest heating shadow integration', () => {
  it('records chronological heating and idle evidence without changing existing learning', () => {
    const state = collect();
    const withoutShadow = collect(false);
    expect(state.objectiveProfiles).toEqual(withoutShadow.objectiveProfiles);
    expect(withoutShadow.heatingShadow).toBeUndefined();
    const day = state.heatingShadow!.days[0]!;
    expect(day.devices.room!.intervals).toHaveLength(2);
    expect(day.devices.room!.intervals[0]!.inputKWh).toBeCloseTo(0.25);
    expect(day.devices.room!.intervals[1]!.inputKWh).toBe(0);
    expect(day.outdoor).toMatchObject([
      { state: 'available', temperatureC: -2 }, { state: 'unavailable' },
    ]);
    expect(readHeatingShadowDaily(state, START + 24 * 3_600_000, TIME_ZONE)?.title)
      .toBe('Daily heating observations');
  });

  it('round-trips the bounded chronological state through the existing per-home tracker store', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = createTrackerStore(db);
    const state = collect();
    expect(isPlausiblePowerTrackerState(state)).toBe(true);
    store.save('main', state);
    expect(store.load('main')).toEqual(state);
    store.save('cabin', { buckets: { '2026-11-02T00:00:00.000Z': 2 } });
    expect(store.load('cabin')?.heatingShadow).toBeUndefined();
    const restored = store.load('main')!;
    const continued = recordHeatingShadowFromSnapshot(restored, [device(35)], START + 35 * MINUTE_MS,
      undefined, () => 'heating', TIME_ZONE);
    expect(continued.heatingShadow!.days[0]!.devices.room!.intervals[0]!.inputKWh).toBeCloseTo(0.25);
    expect(continued.heatingShadow!.days[0]!.devices.room!.window!.last.atMs).toBe(START + 35 * MINUTE_MS);
    const changesBefore = db.prepare('SELECT total_changes() AS count').get() as { count: number };
    store.save('main', continued);
    const changesAfter = db.prepare('SELECT total_changes() AS count').get() as { count: number };
    // Stable history is separate rows: this checkpoint updates only the open window.
    expect(changesAfter.count - changesBefore.count).toBe(1);
    expect(store.load('main')).toEqual(continued);
    db.close();
  });

  it('quarantines malformed persisted observation rows without losing ordinary accounting', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = createTrackerStore(db);
    const state = collect();
    store.save('main', state);
    db.prepare("UPDATE power_tracker_scalars SET value_json = 'null' WHERE home_id = 'main' AND key LIKE '%/interval/%'")
      .run();
    const restored = store.load('main');
    expect(restored?.buckets).toEqual(state.buckets);
    expect(restored?.heatingShadow).toBeUndefined();
    const leftovers = db.prepare("SELECT COUNT(*) AS count FROM power_tracker_scalars WHERE key LIKE 'heatingShadow%'")
      .get() as { count: number };
    expect(leftovers.count).toBe(0);
    db.close();
  });

  it.each(['orphan', 'timestamp mismatch'])('quarantines %s rows outside the canonical shadow layout', (fault) => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    const store = createTrackerStore(db);
    const state = collect();
    store.save('main', state);
    if (fault === 'orphan') {
      db.prepare('INSERT INTO power_tracker_scalars (home_id, key, value_json) VALUES (?, ?, ?)')
        .run('main', 'heatingShadow/unused', 'null');
    } else {
      db.prepare("UPDATE power_tracker_scalars SET key = key || '/mismatch' WHERE key LIKE '%/interval/%'")
        .run();
    }
    expect(store.load('main')).toEqual({ buckets: state.buckets });
    db.close();
  });

  it('salvages billing and learned state when persisted shadow data is malformed', () => {
    const state = collect();
    const salvaged = salvagePowerTrackerState({ ...state, heatingShadow: { version: 999 } });
    expect(salvaged?.state.buckets).toEqual(state.buckets);
    expect(salvaged?.state.objectiveProfiles).toEqual(state.objectiveProfiles);
    expect(salvaged?.state.heatingShadow).toBeUndefined();
    expect(salvaged?.dropped).toContain('heatingShadow');
  });

  it('excludes indirect power and interrupts evidence when the device becomes unmanaged', () => {
    const indirect = { ...device(0), measuredPowerIsDirectMeasurement: false };
    expect(recordHeatingShadowFromSnapshot({}, [indirect], START, undefined, () => 'heating', TIME_ZONE)
      .heatingShadow).toBeUndefined();
    const state = recordHeatingShadowFromSnapshot({}, [device(0)], START, undefined, () => 'heating', TIME_ZONE);
    const interrupted = recordHeatingShadowFromSnapshot(state, [device(5, false)], START + 5 * MINUTE_MS,
      undefined, () => 'heating', TIME_ZONE);
    expect(interrupted.heatingShadow!.days[0]!.devices.room!.window).toBeUndefined();
    expect(interrupted.heatingShadow!.days[0]!.devices.room!.interruptions).toBe(1);
  });

  it('contains shadow-collection failures without changing the input tracker', () => {
    const before: PowerTrackerState = { buckets: { '2026-11-02T00:00:00.000Z': 1.25 } };
    const state = recordHeatingShadowFromSnapshot(before, [device(0)], START, undefined, () => 'heating', 'invalid/timezone');
    expect(state).toBe(before);
  });
});
