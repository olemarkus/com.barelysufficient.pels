import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeviceEventStore,
  DEVICE_EVENT_MAX_ENTRIES_PER_DEVICE,
  DEVICE_EVENT_RETENTION_DAYS,
} from '../../lib/diagnostics/deviceEventStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';

const NOW = Date.UTC(2026, 9, 24, 14, 39);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('device event journal', () => {
  const databases: UserdataDatabase[] = [];
  const open = (): UserdataDatabase => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    databases.push(db);
    return db;
  };
  afterEach(() => {
    vi.useRealTimers();
    for (const db of databases.splice(0)) db.close();
  });

  it('keeps an event about a charger and a car once, readable from either device', () => {
    vi.useFakeTimers({ now: NOW });
    const store = createDeviceEventStore(open());
    store.record(['charger', 'car'], {
      component: 'devices', event: 'ev_car_link_late_car_report', chargerId: 'charger', carId: 'car', lateByMs: 5,
    });
    store.record(['other'], { component: 'devices', event: 'ev_car_link_plug_edge', deviceId: 'other' });

    const read = store.read(['charger', 'car'], NOW - 1, NOW);
    expect(read).toEqual([{
      id: expect.any(String), atMs: NOW, deviceIds: expect.arrayContaining(['charger', 'car']),
      event: 'ev_car_link_late_car_report', details: { chargerId: 'charger', carId: 'car', lateByMs: 5 },
    }]);
    expect(store.read(['car'], NOW - 1, NOW).map((entry) => entry.event)).toEqual(['ev_car_link_late_car_report']);
    expect(store.read(['charger'], NOW + 1, NOW + 2)).toEqual([]);
  });

  it('survives reopening the database, oldest first', () => {
    vi.useFakeTimers({ now: NOW });
    const db = open();
    createDeviceEventStore(db).record(['charger'], { component: 'devices', event: 'first' });
    vi.setSystemTime(NOW + 1_000);
    createDeviceEventStore(db).record(['charger'], { component: 'devices', event: 'second' });
    expect(createDeviceEventStore(db).read(['charger'], 0, NOW + 1_000).map((entry) => entry.event))
      .toEqual(['first', 'second']);
  });

  it('keeps the newest events per device and forgets those past retention', () => {
    vi.useFakeTimers({ now: NOW - DEVICE_EVENT_RETENTION_DAYS * DAY_MS - 1 });
    const store = createDeviceEventStore(open());
    store.record(['charger', 'car'], { component: 'devices', event: 'expired' });
    vi.setSystemTime(NOW);
    for (let index = 0; index < DEVICE_EVENT_MAX_ENTRIES_PER_DEVICE + 5; index += 1) {
      store.record(['charger'], { component: 'devices', event: `charger-${index}` });
    }
    const charger = store.read(['charger'], 0, NOW);
    expect(charger).toHaveLength(DEVICE_EVENT_MAX_ENTRIES_PER_DEVICE);
    expect(store.read(['car'], 0, NOW)).toEqual([]);
  });

  it('quarantines a damaged row instead of reporting it', () => {
    vi.useFakeTimers({ now: NOW });
    const db = open();
    const store = createDeviceEventStore(db);
    store.record(['charger'], { component: 'devices', event: 'kept' });
    db.prepare('INSERT INTO device_event_history (id, device_id, at_ms, event_json) VALUES (?, ?, ?, ?)')
      .run('damaged', 'charger', NOW, '{"no-event": true}');
    expect(store.read(['charger'], 0, NOW).map((entry) => entry.event)).toEqual(['kept']);
    expect(db.prepare('SELECT COUNT(*) AS rows FROM device_event_history WHERE id = ?').get('damaged'))
      .toEqual({ rows: 0 });
  });

  it('never throws into the decision that produced the event', () => {
    const db = open();
    const store = createDeviceEventStore(db);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    expect(() => store.record(['charger'], { component: 'devices', event: 'lost' })).not.toThrow();
  });
});
