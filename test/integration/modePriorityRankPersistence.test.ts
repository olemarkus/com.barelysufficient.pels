// A managed device with no rank gets one persisted once by its home's mode
// catalog owner, instead of having its place inferred on every read. Only a
// fresh read of the priorities may be written back: a retained generation
// (unreadable or malformed key) could be the empty boot default, and writing it
// would wipe the owner's order. Device ownership must be settled first.
import { describe, expect, it, vi } from 'vitest';
import { createHomeModeCatalog } from '../../lib/home/homeModeCatalog';
import type { HomeMembershipPort } from '../../lib/home/membership';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { HomeBatteryDevicesRead } from '../../lib/ports/homeBatteryDevices';
import { CAPACITY_PRIORITIES, MAIN_HOME_ID, homeScopedSettingsKey } from '../../lib/utils/settingsKeys';

const createSettings = (initial: Record<string, unknown>): SettingsPort & { writes: string[] } => {
  const store = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    writes,
    get: (key) => store.get(key),
    set: (key, value) => { writes.push(key); store.set(key, value); },
    unset: (key) => { store.delete(key); },
    getKeys: () => [...store.keys()],
  };
};

const settledMembership = (homeByDevice: Record<string, string> = {}): HomeMembershipPort => ({
  getHomeIdForDevice: (deviceId: string) => homeByDevice[deviceId] ?? MAIN_HOME_ID,
  isOwnershipReady: () => true,
  hasPendingOwnershipGeneration: () => false,
} as unknown as HomeMembershipPort);

const NO_BATTERIES = (): HomeBatteryDevicesRead => ({ status: 'resolved', deviceIds: new Set() });

const createMainCatalog = (
  settings: SettingsPort,
  managed: Record<string, boolean>,
  membership: HomeMembershipPort | undefined = settledMembership(),
  readHomeBatteries: () => HomeBatteryDevicesRead = () => ({ status: 'resolved', deviceIds: new Set(['battery-1']) }),
) => createHomeModeCatalog(
  MAIN_HOME_ID,
  settings,
  () => { throw new Error('Main reads no other home'); },
  () => managed,
  () => membership,
  () => undefined,
  readHomeBatteries,
);

describe('persisting ranks for unranked managed devices', () => {
  it('writes a rank once for a newly managed device, after the ranked ones', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 1, tank: 2 } },
      mode_device_targets: { Home: {} },
    });
    const managed = { heater: true, tank: true, charger: true };
    const catalog = createMainCatalog(settings, managed);

    expect(settings.get(CAPACITY_PRIORITIES)).toEqual({ Home: { heater: 1, tank: 2, charger: 3 } });
    expect(settings.writes.filter((key) => key === CAPACITY_PRIORITIES)).toHaveLength(1);

    catalog.reload();
    expect(settings.writes.filter((key) => key === CAPACITY_PRIORITIES)).toHaveLength(1);
    expect(catalog.getPrioritiesForDevices(['charger', 'heater', 'tank']).getPriority('charger')).toBe(3);
  });

  it('writes nothing when every managed device is already ranked', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 2, tank: 1 } },
      mode_device_targets: { Home: {} },
    });
    createMainCatalog(settings, { heater: true, tank: true, unmanaged: false });
    expect(settings.writes).toEqual([]);
  });

  it('backfills a home whose priorities were never written', () => {
    const settings = createSettings({ mode_device_targets: { Home: {}, Away: {} } });
    createMainCatalog(settings, { b: true, a: true });
    expect(settings.get(CAPACITY_PRIORITIES)).toEqual({ Home: { a: 1, b: 2 }, Away: { a: 1, b: 2 } });
  });

  it('never writes back a retained generation after an unreadable priorities key', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 1 } },
      mode_device_targets: { Home: {} },
    });
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (
      key === CAPACITY_PRIORITIES ? { Home: 'malformed' } : undefined
    ));
    createMainCatalog(settings, { heater: true, charger: true });
    get.mockRestore();
    expect(settings.writes).toEqual([]);
    expect(settings.get(CAPACITY_PRIORITIES)).toEqual({ Home: { heater: 1 } });
  });

  it('waits for settled device ownership before writing', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 1 } },
      mode_device_targets: { Home: {} },
    });
    const pending = {
      ...settledMembership(),
      hasPendingOwnershipGeneration: () => true,
    } as unknown as HomeMembershipPort;
    createMainCatalog(settings, { heater: true, charger: true }, pending);
    expect(settings.writes).toEqual([]);
  });

  it('ranks only the devices this home owns', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 1 } },
      mode_device_targets: { Home: {} },
    });
    createMainCatalog(settings, { heater: true, cabin: true, charger: true }, settledMembership({ cabin: 'cabin-home' }));
    expect(settings.get(CAPACITY_PRIORITIES)).toEqual({ Home: { heater: 1, charger: 2 } });
  });

  it('waits for device ownership to exist, then writes on the reload it triggers', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 1 } },
      mode_device_targets: { Home: {} },
    });
    const ownership: { membership?: HomeMembershipPort } = {};
    const catalog = createHomeModeCatalog(
      MAIN_HOME_ID, settings, () => { throw new Error('unused'); },
      () => ({ heater: true, charger: true }), () => ownership.membership, () => undefined,
      NO_BATTERIES,
    );
    expect(settings.writes).toEqual([]);
    ownership.membership = settledMembership();
    catalog.reload();
    expect(settings.get(CAPACITY_PRIORITIES)).toEqual({ Home: { heater: 1, charger: 2 } });
  });

  it('never brings back a mode the priorities no longer store (delete or rename in progress)', () => {
    const settings = createSettings({
      // The settings UI writes the priorities without the deleted mode first;
      // the targets still list it until the next write lands.
      [CAPACITY_PRIORITIES]: { Home: { heater: 1, charger: 2 } },
      mode_device_targets: { Home: {}, Guests: {} },
    });
    createMainCatalog(settings, { heater: true, charger: true });
    expect(settings.writes).toEqual([]);
  });

  it('never stores an unconfigured active mode', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 1 } },
      mode_device_targets: { Home: {} },
    });
    const catalog = createMainCatalog(settings, { heater: true });
    catalog.setOperatingMode('Away');
    expect(Object.keys(settings.get(CAPACITY_PRIORITIES) as object)).toEqual(['Home']);
  });

  it('persists ranks in a meter area\'s own catalog', () => {
    const area = 'cabin';
    const settings = createSettings({
      [homeScopedSettingsKey('mode_aliases', area)]: {},
      [homeScopedSettingsKey(CAPACITY_PRIORITIES, area)]: { Home: { heater: 1 } },
      [homeScopedSettingsKey('mode_device_targets', area)]: { Home: {} },
      [homeScopedSettingsKey('operating_mode', area)]: 'Home',
      [homeScopedSettingsKey('mode_catalog_initialized', area)]: true,
    });
    const main = createMainCatalog(createSettings({}), {});
    const catalog = createHomeModeCatalog(
      area, settings, main.getSnapshot,
      () => ({ heater: true, sauna: true, kitchen: true }),
      () => settledMembership({ heater: area, sauna: area }), () => undefined,
      NO_BATTERIES,
    );
    catalog.reload();
    expect(settings.get(homeScopedSettingsKey(CAPACITY_PRIORITIES, area))).toEqual({ Home: { heater: 1, sauna: 2 } });
    expect(settings.writes).toEqual([homeScopedSettingsKey(CAPACITY_PRIORITIES, area)]);
  });

  it('inserts a newly managed device above a home battery at the bottom', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 1, 'battery-1': 2 } },
      mode_device_targets: { Home: {} },
    });
    createMainCatalog(settings, { heater: true, charger: true });
    expect(settings.get(CAPACITY_PRIORITIES)).toEqual({ Home: { heater: 1, charger: 2, 'battery-1': 3 } });
  });

  it('waits to persist while the home batteries are not known yet', () => {
    const settings = createSettings({
      [CAPACITY_PRIORITIES]: { Home: { heater: 1, 'battery-1': 2 } },
      mode_device_targets: { Home: {} },
    });
    let batteries: HomeBatteryDevicesRead = { status: 'unavailable' };
    const catalog = createMainCatalog(settings, { heater: true, charger: true }, settledMembership(), () => batteries);
    expect(settings.writes).toEqual([]);

    batteries = { status: 'resolved', deviceIds: new Set(['battery-1']) };
    catalog.reload();
    expect(settings.get(CAPACITY_PRIORITIES)).toEqual({ Home: { heater: 1, charger: 2, 'battery-1': 3 } });
  });
});
