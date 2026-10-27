import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEVICE_ACTIVITY_SETTLE_MS, DeviceOverviewLogRecorder } from '../../lib/diagnostics/deviceActivityRecorder';
import { createDeviceActivityStore } from '../../lib/diagnostics/deviceActivityStore';
import { DEVICE_ACTIVITY_RETENTION_MS } from '../../lib/diagnostics/deviceActivityHistory';
import { IN_MEMORY_DATABASE, openUserdataDatabase, type UserdataDatabase } from '../../lib/store/userdataDatabase';
import type { SettingsUiDeviceActivityEntry } from '../../packages/contracts/src/settingsUiApi';
import { buildOverviewDeviceCard, overviewReadModelWiring } from '../utils/settingsOverviewFixture';
import { buildPlanDevice } from '../utils/planTestUtils';
import { executionStateFixture } from '../utils/deviceStatusFixture';

const NOW = Date.UTC(2026, 9, 23, 12);
const entry = (overrides: Partial<SettingsUiDeviceActivityEntry> = {}): SettingsUiDeviceActivityEntry => ({
  id: 'e1', deviceId: 'heater', deviceName: 'Hall heater', atMs: NOW,
  recordingStartedAtMs: NOW - 60_000, stateMsg: 'Limited', stateKind: 'held', stateTone: 'held',
  powerMsg: '0.0 kW', usageMsg: '18 °C · target 22 °C', statusMsg: 'Waiting for capacity', ...overrides,
});
const device = () => {
  const planned = buildPlanDevice({ id: 'heater', name: 'Hall heater' });
  return buildOverviewDeviceCard(planned, {
    ...overviewReadModelWiring(), dryRun: false, nowMs: NOW,
    getDeviceExecutionState: () => executionStateFixture(planned),
    getThermalDirection: () => 'heating',
    getObservedTemperature: () => ({ kind: 'absent' }),
    getObservedStateOfCharge: () => ({ kind: 'absent' }),
    getHomeBatteryCard: () => ({ kind: 'none' }),
    getObservedEvChargingState: () => ({ kind: 'absent' }),
  });
};

describe('persistent device activity', () => {
  const databases: UserdataDatabase[] = [];
  const folders: string[] = [];
  const open = (location = IN_MEMORY_DATABASE): UserdataDatabase => {
    const db = openUserdataDatabase(location);
    databases.push(db);
    return db;
  };

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('keeps previous observations across a database reopen and starts a separate recording session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-activity-'));
    folders.push(dir);
    const location = path.join(dir, 'pels.sqlite');
    const db = open(location);
    const before = new DeviceOverviewLogRecorder(createDeviceActivityStore(db, 'main'));
    before.record(device(), entry(), 'signature');
    vi.advanceTimersByTime(DEVICE_ACTIVITY_SETTLE_MS);
    before.flush();
    db.close();

    vi.setSystemTime(NOW + 60_000);
    const after = new DeviceOverviewLogRecorder(createDeviceActivityStore(open(location), 'main'));
    after.record(device(), entry({ atMs: NOW + 60_000, stateMsg: 'Running' }), 'signature');
    vi.advanceTimersByTime(DEVICE_ACTIVITY_SETTLE_MS);
    const payload = after.getUiPayload();
    expect(payload.persistence).toBe('stored');
    expect(payload.entries.map((e) => e.stateMsg)).toEqual(['Running', 'Limited']);
    expect(payload.entries.map((e) => e.recordingStartedAtMs)).toEqual([NOW + 60_000, NOW]);
    expect(payload.entries[1].deviceName).toBe('Hall heater');
  });

  it('retains the latest 100 entries per device and 1000 per home, newest first', () => {
    const db = open();
    const main = createDeviceActivityStore(db, 'main');
    const other = createDeviceActivityStore(db, 'garage');
    other.append([entry({ id: 'event-1209' })], NOW);
    main.append(Array.from({ length: 1210 }, (_, i) => entry({
      id: `event-${i}`, deviceId: `device-${Math.floor(i / 110)}`, atMs: NOW - 1210 + i,
    })), NOW);
    const saved = main.read(NOW);
    expect(saved).toHaveLength(1000);
    expect(saved[0].id).toBe('event-1209');
    expect(saved.at(-1)?.id).toBe('event-120');
    expect(saved.filter((e) => e.deviceId === 'device-10')).toHaveLength(100);
    expect(other.read(NOW).map((e) => e.id)).toEqual(['event-1209']);
    expect(db.prepare('SELECT count(*) AS n FROM device_activity_history').get()).toEqual({ n: 1001 });
  });

  it('expires stored observations even when no new transitions are recorded', () => {
    const db = open();
    const store = createDeviceActivityStore(db, 'main');
    store.append([entry()], NOW);
    createDeviceActivityStore(db, 'removed-area').append([entry()], NOW);
    expect(store.read(NOW + DEVICE_ACTIVITY_RETENTION_MS)).toHaveLength(1);
    expect(store.read(NOW + DEVICE_ACTIVITY_RETENTION_MS + 1)).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM device_activity_history').get()).toEqual({ n: 0 });
  });

  it('drops malformed persisted rows without losing valid neighbouring history', () => {
    const db = open();
    const store = createDeviceActivityStore(db, 'main');
    store.append([entry(), entry({ id: 'bad' }), entry({ id: 'mismatch' })], NOW);
    db.prepare('UPDATE device_activity_history SET entry_json = ? WHERE id = ?').run('{broken', 'bad');
    db.prepare('UPDATE device_activity_history SET device_id = ? WHERE id = ?').run('wrong', 'mismatch');
    expect(store.read(NOW).map((e) => e.id)).toEqual(['e1']);
    expect(db.prepare('SELECT count(*) AS n FROM device_activity_history').get()).toEqual({ n: 1 });
  });

  it('retries failed saves on an unchanged capture without duplicating committed entries', () => {
    const store = createDeviceActivityStore(open(), 'main');
    const append = vi.fn(store.append).mockImplementationOnce((entries, nowMs) => {
      store.append(entries, nowMs);
      throw new Error('save acknowledgement failed');
    });
    const recorder = new DeviceOverviewLogRecorder({ append, read: store.read });
    recorder.record(device(), entry(), 'signature');
    vi.advanceTimersByTime(DEVICE_ACTIVITY_SETTLE_MS);
    expect(() => recorder.flush()).not.toThrow();
    expect(recorder.getUiPayload().persistence).toBe('pending');
    expect(recorder.getUiPayload().entries).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    recorder.flush();
    expect(append).toHaveBeenCalledTimes(2);
    expect(recorder.getUiPayload().persistence).toBe('stored');
    expect(store.read(NOW)).toHaveLength(1);
  });

  it('bounds the pending queue during an outage', () => {
    const append = vi.fn(() => { throw new Error('disk full'); });
    const recorder = new DeviceOverviewLogRecorder({ append, read: () => [] });
    for (let i = 0; i < 110; i += 1) {
      recorder.record(device(), entry({ atMs: Date.now(), statusMsg: `Reason ${i}` }), `reason-${i}`);
      vi.advanceTimersByTime(DEVICE_ACTIVITY_SETTLE_MS);
      recorder.flush();
    }
    const pending = recorder.getUiPayload();
    expect(pending.entries).toHaveLength(100);
    expect(pending.entries[0].statusMsg).toBe('Reason 109');
    expect(pending.entries.at(-1)?.statusMsg).toBe('Reason 10');
    expect(pending.persistence).toBe('pending');
    vi.setSystemTime(Date.now() + DEVICE_ACTIVITY_RETENTION_MS + 1);
    expect(recorder.getUiPayload()).toMatchObject({ entries: [], persistence: 'stored' });
  });

  it('replaces a row the device leaves within moments, keeping when the change began', () => {
    // Prod 2026-10-26: "Limited 1.1 kW", then "Limited · Off" a second later as
    // the device reported off; "Resuming", then "Running" as it drew.
    const store = createDeviceActivityStore(open(), 'main');
    const recorder = new DeviceOverviewLogRecorder(store);
    recorder.record(device(), entry({ atMs: NOW, stateMsg: 'Limited', powerMsg: '1.1 kW' }), 'limited');
    vi.advanceTimersByTime(4_000);
    recorder.record(device(), entry({ atMs: NOW + 4_000, stateMsg: 'Limited · Off', powerMsg: '0.0 kW' }), 'off');
    vi.advanceTimersByTime(DEVICE_ACTIVITY_SETTLE_MS);
    recorder.flush();
    expect(store.read(Date.now()).map((e) => [e.atMs, e.stateMsg, e.powerMsg]))
      .toEqual([[NOW, 'Limited · Off', '0.0 kW']]);
    // A row longer than that stays, and one back where it was within moments leaves none.
    recorder.record(device(), entry({ atMs: Date.now(), stateKind: 'resuming', stateMsg: 'Resuming' }), 'resuming');
    vi.advanceTimersByTime(2_000);
    recorder.record(device(), entry({ atMs: Date.now(), stateMsg: 'Limited · Off', powerMsg: '0.0 kW' }), 'off');
    vi.advanceTimersByTime(DEVICE_ACTIVITY_SETTLE_MS);
    recorder.flush();
    expect(store.read(Date.now())).toHaveLength(1);
    // A return that differs in what the log records, such as the charger now unplugged, is a row.
    recorder.record(device(), entry({ atMs: Date.now(), stateKind: 'resuming', stateMsg: 'Resuming' }), 'resuming');
    vi.advanceTimersByTime(2_000);
    recorder.record(device(), entry({ atMs: Date.now(), stateMsg: 'Limited · Off', usageMsg: 'Unplugged' }), 'off-unplugged');
    vi.advanceTimersByTime(DEVICE_ACTIVITY_SETTLE_MS);
    recorder.flush();
    expect(store.read(Date.now()).map((e) => e.usageMsg)).toEqual(['Unplugged', '18 °C · target 22 °C']);
  });

  it('surfaces a failed read as unavailable, while later saves preserve old history', () => {
    const store = createDeviceActivityStore(open(), 'main');
    store.append([entry({ id: 'older' })], NOW);
    const read = vi.fn(store.read).mockImplementationOnce(() => { throw new Error('read failed'); });
    const recorder = new DeviceOverviewLogRecorder({ append: store.append, read });
    expect(() => recorder.getUiPayload()).toThrow('read failed');
    recorder.record(device(), entry({ atMs: NOW + 1 }), 'signature');
    expect(recorder.getUiPayload().entries).toHaveLength(2);
  });
});
