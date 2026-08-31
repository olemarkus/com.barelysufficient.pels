import type Homey from 'homey';
import { MockSettings } from '../mocks/homey';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import {
  classifyMainMeterAuthorityState,
  MAIN_METER_AUTHORITY_MIGRATION_MARKER,
  runMainMeterAuthorityMigration,
} from '../../setup/mainMeterAuthorityMigration';
import { TimerRegistry } from '../../lib/utils/timerRegistry';

const METER_ID = 'meter-device-1';
const OTHER_METER_ID = 'meter-device-2';

const makeHomey = (initial: Record<string, unknown>): Homey.App['homey'] => {
  const settings = new MockSettings();
  for (const [key, value] of Object.entries(initial)) settings.set(key, value);
  return { settings } as unknown as Homey.App['homey'];
};

// Fresh installs never hit the empty-key-list defer in production: the v1/v2
// boot migrations run first in `runStartupSettingsMigrations` and set their
// markers, so at least one key exists by the time this migration classifies.
const FRESH_INSTALL_BASE = { boot_migrations_v1_ev_setting_cleanup_done: true };

const soleMeterReport = { items: [{ type: 'cumulative', id: METER_ID, values: { W: 1200 } }] };
const multiMeterReport = {
  items: [
    { type: 'cumulative', id: METER_ID, values: { W: 1200 } },
    { type: 'cumulative', id: OTHER_METER_ID, values: { W: 900 } },
  ],
};
const idlessAggregateReport = { items: [{ type: 'cumulative', values: { W: 640 } }] };

const stubReport = (report: unknown): void => {
  vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(report);
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('classifyMainMeterAuthorityState', () => {
  it('classifies an explicit flow source as conformant', () => {
    const homey = makeHomey({ power_source: 'flow' });
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({
      kind: 'conformant',
      detail: 'flow_source',
    });
  });

  it('classifies a stored garbage source as conformant flow (normalizePowerSource semantics)', () => {
    const homey = makeHomey({ power_source: 'wibble' });
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({
      kind: 'conformant',
      detail: 'flow_source',
    });
  });

  it('classifies homey_energy with a valid explicit meter as conformant', () => {
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: METER_ID });
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({
      kind: 'conformant',
      detail: 'explicit_meter',
    });
  });

  it('defers on a malformed stored meter id instead of reading it as Automatic', () => {
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: 'bad|id' });
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({
      kind: 'defer',
      reasonCode: 'suspect_meter_value',
    });
  });

  it('classifies homey_energy with a stored null meter as resolve_automatic', () => {
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({ kind: 'resolve_automatic' });
  });

  it('classifies homey_energy with a never-written meter key as resolve_automatic', () => {
    const homey = makeHomey({ power_source: 'homey_energy' });
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({ kind: 'resolve_automatic' });
  });

  it('classifies an unset source with persisted tracker history as write_flow', () => {
    const homey = makeHomey({ ...FRESH_INSTALL_BASE, power_tracker_state: { lastPowerW: 500 } });
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({
      kind: 'write_flow',
      detail: 'unset_source_with_history',
    });
  });

  it('classifies an unset source with no history as detect_fresh_install', () => {
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({ kind: 'detect_fresh_install' });
  });

  it('defers when the listed meter key transiently answers undefined instead of reading it as Automatic', () => {
    const store: Record<string, unknown> = { power_source: 'homey_energy', homey_energy_meter_device_id: METER_ID };
    const port = {
      // The key is listed but the read comes back undefined — the documented
      // transient-miss shape for an explicitly configured meter.
      get: (key: string): unknown => (key === 'homey_energy_meter_device_id' ? undefined : store[key]),
      getKeys: (): string[] => Object.keys(store),
    };
    expect(classifyMainMeterAuthorityState(port)).toEqual({
      kind: 'defer',
      reasonCode: 'missing_existing_key',
    });
  });

  it('defers on an entirely empty key list (indistinguishable from a failed read)', () => {
    const homey = makeHomey({});
    expect(classifyMainMeterAuthorityState(homey.settings)).toEqual({
      kind: 'defer',
      reasonCode: 'empty_key_list',
    });
  });
});

describe('runMainMeterAuthorityMigration', () => {
  it('does nothing when the marker is already set', () => {
    const homey = makeHomey({ [MAIN_METER_AUTHORITY_MIGRATION_MARKER]: true });
    const reportSpy = vi.spyOn(homeyApi, 'getEnergyLiveReport');
    const set = vi.spyOn(homey.settings, 'set');
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    expect(reportSpy).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('marks a conformant explicit-meter install without touching its keys', () => {
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: METER_ID });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
  });

  it('writes flow synchronously for an unset source with tracker history', () => {
    const homey = makeHomey({ ...FRESH_INSTALL_BASE, power_tracker_state: { lastPowerW: 500 } });
    const reportSpy = vi.spyOn(homeyApi, 'getEnergyLiveReport');
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    expect(homey.settings.get('power_source')).toBe('flow');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('persists the sole cumulative meter for an Automatic upgrade, on the second consecutive attempt', async () => {
    vi.useFakeTimers();
    stubReport(soleMeterReport);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    // First attempt only proposes: one read never seals a permanent answer.
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBeNull();
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('demotes an ambiguous Automatic upgrade (several cumulative meters) to flow', async () => {
    vi.useFakeTimers();
    stubReport(multiMeterReport);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('power_source')).toBe('flow');
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('demotes a sole id-less aggregate (nothing nameable to persist) to flow', async () => {
    vi.useFakeTimers();
    stubReport(idlessAggregateReport);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('power_source')).toBe('flow');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('retries on an unavailable energy report and withholds the marker until it resolves', async () => {
    vi.useFakeTimers();
    const reportSpy = vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBeNull();
    reportSpy.mockResolvedValue(soleMeterReport);
    await vi.advanceTimersByTimeAsync(5_000);
    // Attempt 1 proposes; the confirming attempt waits the 30 s gap.
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('gives up for the boot after the retry budget and leaves the marker unset', async () => {
    vi.useFakeTimers();
    stubReport(null);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBeNull();
    expect(homey.settings.get('power_source')).toBe('homey_energy');
  });

  it('configures homey_energy + meter for a fresh single-home install with one cumulative meter', async () => {
    vi.useFakeTimers();
    stubReport(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('writes flow for a fresh install with several cumulative meters', async () => {
    vi.useFakeTimers();
    stubReport(multiMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('power_source')).toBe('flow');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('writes flow for a fresh install whose report stays empty through the whole retry ladder', async () => {
    vi.useFakeTimers();
    stubReport({ items: [] });
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    // An empty report is retryable — a warming meter must get the whole
    // ladder to appear before a flow-only install is concluded.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(homey.settings.get('power_source')).toBe('flow');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('abandons (no marker, no writes) when areas are running and Automatic is unresolvable', async () => {
    vi.useFakeTimers();
    stubReport(multiMeterReport);
    const homey = makeHomey({
      power_source: 'homey_energy',
      homey_energy_meter_device_id: null,
      homes_config: {
        activationVersion: 1,
        subHomes: [{ homeId: 'area1', name: 'Annex', rootZoneId: 'z1', meterDeviceId: OTHER_METER_ID }],
      },
    });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBeNull();
  });

  it('falls to flow when Automatic resolved to a meter an area already owns', async () => {
    vi.useFakeTimers();
    stubReport(soleMeterReport);
    const homey = makeHomey({
      power_source: 'homey_energy',
      homey_energy_meter_device_id: null,
      // The area owns the sole cumulative meter, but the config is dormant
      // (no activation marker, legacy flag absent) — flow demotion is allowed.
      homes_config: {
        subHomes: [{ homeId: 'area1', name: 'Annex', rootZoneId: 'z1', meterDeviceId: METER_ID }],
      },
    });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('power_source')).toBe('flow');
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('stops and commits when a concurrent save makes the home conformant mid-chain', async () => {
    vi.useFakeTimers();
    const reportSpy = vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    // The owner picks a meter through the settings UI while the chain retries.
    homey.settings.set('homey_energy_meter_device_id', OTHER_METER_ID);
    reportSpy.mockResolvedValue(soleMeterReport);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    // The chain observed the save, committed the marker, and never overwrote
    // the owner's pick with its own census result.
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(OTHER_METER_ID);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('never demotes an Automatic home off a transiently empty report', async () => {
    vi.useFakeTimers();
    const reportSpy = vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ items: [] });
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(0);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    // The report warms up: the sole meter appears and gets persisted instead.
    reportSpy.mockResolvedValue(soleMeterReport);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('requires consecutive agreement: a flip-flopping census never executes the first conclusion', async () => {
    vi.useFakeTimers();
    const reportSpy = vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValueOnce(multiMeterReport);
    reportSpy.mockResolvedValue(soleMeterReport);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    // Attempt 0 proposes the Flow demotion (ambiguous census); attempt 1 sees
    // the sole meter and proposes the persist instead — no write either time.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBeNull();
    // Attempt 2 agrees with attempt 1: the persist executes.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('a save landing during the awaited fetch wins — reclassification is the last read before any write', async () => {
    vi.useFakeTimers();
    // The fetch resolves only after the owner's save has landed.
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockImplementation(async () => {
      homey.settings.set('homey_energy_meter_device_id', OTHER_METER_ID);
      return soleMeterReport;
    });
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(OTHER_METER_ID);
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBe(true);
  });

  it('a fresh install whose ladder ends on ONE empty read after failed fetches defers instead of demoting', async () => {
    vi.useFakeTimers();
    const reportSpy = vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    // Eleven failed fetches, then the report answers — empty — on the final attempt.
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    reportSpy.mockResolvedValue({ items: [] });
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    // One empty census is not a streak: marker withheld, next boot retries.
    expect(homey.settings.get('power_source')).toBeNull();
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBeNull();
  });

  it('an Automatic home whose report stays empty defers this boot instead of demoting', async () => {
    vi.useFakeTimers();
    stubReport({ items: [] });
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    runMainMeterAuthorityMigration({ homey, timers: new TimerRegistry() });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    // Ladder exhausted: marker withheld, source untouched — the next boot
    // retries. Only a fresh install concludes flow from an empty census.
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(homey.settings.get(MAIN_METER_AUTHORITY_MIGRATION_MARKER)).toBeNull();
  });
});
