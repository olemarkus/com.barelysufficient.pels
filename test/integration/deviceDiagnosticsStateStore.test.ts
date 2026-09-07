import {
  createDeviceDiagnosticsStateStore,
  importLegacyDeviceDiagnostics,
} from '../../lib/diagnostics/deviceDiagnosticsStateStore';
import type { PersistedDayAggregate, PersistedDiagnosticsState } from '../../lib/diagnostics/deviceDiagnosticsModel';
import { DEVICE_DIAGNOSTICS_STATE_KEY } from '../../lib/diagnostics/deviceDiagnosticsPersistence';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { MockSettings } from '../mocks/homey';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createDeviceDiagnosticsStateStore(db) };
};

const day = (unmetDemandMs: number): PersistedDayAggregate => ({
  unmetDemandMs,
  blockedByHeadroomMs: 0,
  blockedByCooldownBackoffMs: 0,
  targetDeficitMs: 0,
  shedCount: 1,
  restoreCount: 1,
  failedActivationCount: 0,
  stableActivationCount: 0,
  shedToRestoreCount: 0,
  shedToRestoreTotalMs: 0,
  restoreToSetbackCount: 0,
  restoreToSetbackTotalMs: 0,
  restoreToSetbackMinMs: null,
  restoreToSetbackMaxMs: null,
  penaltyBumpCount: 0,
  penaltyMaxLevelSeen: 0,
});

/** Days inside the 21-day window as of the fake clock below. */
const TODAY = '2026-03-10';
const YESTERDAY = '2026-03-09';
const state = (devices: Record<string, Record<string, PersistedDayAggregate>>): PersistedDiagnosticsState => ({
  version: 2,
  windowDays: 21,
  generatedAt: 1_000,
  devicesById: Object.fromEntries(Object.entries(devices).map(([id, days]) => [id, { daysByDateKey: days }])),
});

const rowCount = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT COUNT(*) AS n FROM device_diagnostics_days').get() as { n: number }).n
);
const totalChanges = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-03-10T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('deviceDiagnosticsStateStore', () => {
  it('answers an empty, unrepaired state while empty, and round-trips one row per device-day', () => {
    const { db, store } = open();
    expect(store.read()).toEqual({ state: { version: 2, windowDays: 21, generatedAt: null, devicesById: {} }, repaired: false });
    const written = state({ 'dev-1': { [TODAY]: day(10), [YESTERDAY]: day(20) }, 'dev-2': { [TODAY]: day(30) } });
    store.write(written);
    expect(store.read()).toEqual({ state: written, repaired: false });
    expect(rowCount(db)).toBe(3);
  });

  // The service mutates its state tree in place between flushes, so the diff
  // base is the row's JSON as last written, never an object reference.
  it('writes only the device-days that changed, after in-place mutation, and deletes the ones that went', () => {
    const { db, store } = open();
    const live = state({ 'dev-1': { [TODAY]: day(10), [YESTERDAY]: day(20) } });
    store.write(live);
    const changes = totalChanges(db);
    live.devicesById['dev-1']!.daysByDateKey[TODAY]!.unmetDemandMs = 11;
    delete live.devicesById['dev-1']!.daysByDateKey[YESTERDAY];
    live.generatedAt = 2_000;
    store.write(live);
    // One day upserted, one deleted, `generatedAt` rewritten.
    expect(totalChanges(db) - changes).toBe(3);
    expect(store.read().state).toEqual(live);
    store.write(live);
    expect(totalChanges(db) - changes).toBe(3);
  });

  it('diffs the first write of a fresh store against the rows on disk', () => {
    const { db, store } = open();
    store.write(state({ 'dev-1': { [TODAY]: day(10), [YESTERDAY]: day(20) } }));
    const blind = createDeviceDiagnosticsStateStore(db);
    blind.write(state({ 'dev-1': { [TODAY]: day(10) } }));
    expect(rowCount(db)).toBe(1);
  });

  it('runs the version sanitisation on read, and a write of the reset state clears the old rows', () => {
    const { db, store } = open();
    store.write({ ...state({ 'dev-1': { [TODAY]: day(10), '2025-01-01': day(5) } }), version: 1 });
    const read = store.read();
    expect(read).toMatchObject({ repaired: true, resetReason: expect.stringContaining('version mismatch') });
    // The rows on disk are the diff base, so the service's repair write
    // (the reset, empty state) deletes every old row rather than leaving
    // them under a state that no longer names them.
    store.write(read.state);
    expect(rowCount(db)).toBe(0);
    expect(store.read()).toEqual({ state: { version: 2, windowDays: 21, generatedAt: null, devicesById: {} }, repaired: false });
  });

  it('quarantines a row that does not parse and keeps the rest', () => {
    const { db, store } = open();
    store.write(state({ 'dev-1': { [TODAY]: day(10), [YESTERDAY]: day(20) } }));
    db.prepare('UPDATE device_diagnostics_days SET aggregate_json = ? WHERE date_key = ?').run('{not json', YESTERDAY);
    expect(Object.keys(store.read().state.devicesById['dev-1']!.daysByDateKey)).toEqual([TODAY]);
    expect(rowCount(db)).toBe(1);
  });
});

describe('importLegacyDeviceDiagnostics', () => {
  const rig = () => {
    const settings = new MockSettings();
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the blob into an empty store, retires the key, and reads nothing on the next boot', () => {
    const { settings, store } = rig();
    const legacy = state({ 'dev-1': { [TODAY]: day(10) } });
    settings.set(DEVICE_DIAGNOSTICS_STATE_KEY, legacy);
    importLegacyDeviceDiagnostics(settings, store);
    expect(store.read().state).toEqual(legacy);
    expect(settings.get(DEVICE_DIAGNOSTICS_STATE_KEY)).toBeNull();
    const get = vi.spyOn(settings, 'get');
    importLegacyDeviceDiagnostics(settings, store);
    expect(get).not.toHaveBeenCalled();
  });

  // A boot whose import deferred still lets the service write fresh rows for
  // the rest of the day; the next boot's import combines the two periods of
  // that day — every field is a sum, a count or a min/max — and adopts the
  // days only the blob has.
  it('imports the blob under what the store already holds, combining a day both recorded', () => {
    const { settings, store } = rig();
    store.write(state({ 'dev-1': { [TODAY]: { ...day(99), restoreToSetbackMinMs: 50, restoreToSetbackMaxMs: 60, penaltyMaxLevelSeen: 1 } } }));
    settings.set(DEVICE_DIAGNOSTICS_STATE_KEY, state({
      'dev-1': { [TODAY]: { ...day(10), restoreToSetbackMinMs: 40, restoreToSetbackMaxMs: 45, penaltyMaxLevelSeen: 2 }, [YESTERDAY]: day(20) },
      'dev-2': { [TODAY]: day(30) },
    }));
    importLegacyDeviceDiagnostics(settings, store);
    expect(store.read().state.devicesById).toEqual({
      'dev-1': {
        daysByDateKey: {
          [TODAY]: {
            ...day(109), shedCount: 2, restoreCount: 2, restoreToSetbackMinMs: 40, restoreToSetbackMaxMs: 60, penaltyMaxLevelSeen: 2,
          },
          [YESTERDAY]: day(20),
        },
      },
      'dev-2': { daysByDateKey: { [TODAY]: day(30) } },
    });
    expect(settings.get(DEVICE_DIAGNOSTICS_STATE_KEY)).toBeNull();
  });

  // The store's envelope wins even before it holds a device: a boot whose
  // import deferred stamped `generatedAt` on an empty state, and the next
  // boot's import must not roll that stamp back to the blob's.
  it('keeps the envelope of a store that holds no device yet', () => {
    const { settings, store } = rig();
    store.write({ ...state({}), generatedAt: 2_000 });
    settings.set(DEVICE_DIAGNOSTICS_STATE_KEY, state({ 'dev-1': { [TODAY]: day(10) } }));
    importLegacyDeviceDiagnostics(settings, store);
    expect(store.read().state).toEqual({ ...state({ 'dev-1': { [TODAY]: day(10) } }), generatedAt: 2_000 });
    expect(settings.get(DEVICE_DIAGNOSTICS_STATE_KEY)).toBeNull();
  });

  // A blob the sanitiser resets — another persist version, a malformed
  // envelope — holds nothing usable; a suspect read or a store that cannot
  // answer leaves the key for the next boot.
  it('defers a blob with nothing usable in it, a suspect read, or a store that cannot answer', () => {
    const { settings, store } = rig();
    settings.set(DEVICE_DIAGNOSTICS_STATE_KEY, { ...state({}), version: 1 });
    importLegacyDeviceDiagnostics(settings, store);
    expect(settings.get(DEVICE_DIAGNOSTICS_STATE_KEY)).toEqual({ ...state({}), version: 1 });
    const legacy = state({ 'dev-1': { [TODAY]: day(10) } });
    settings.set(DEVICE_DIAGNOSTICS_STATE_KEY, legacy);
    const write = vi.spyOn(store, 'write').mockImplementation(() => { throw new Error('disk full'); });
    importLegacyDeviceDiagnostics(settings, store);
    write.mockRestore();
    expect(settings.get(DEVICE_DIAGNOSTICS_STATE_KEY)).toEqual(legacy);
    importLegacyDeviceDiagnostics(settings, store);
    expect(store.read().state).toEqual(legacy);
    expect(settings.get(DEVICE_DIAGNOSTICS_STATE_KEY)).toBeNull();
  });
});
