import type Homey from 'homey';
import { runBootMigrations } from '../../setup/appBootMigrations';
import {
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  MANAGED_DEVICES,
} from '../../lib/utils/settingsKeys';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

const EV_SETTING_CLEANUP_MARKER = 'boot_migrations_v1_ev_setting_cleanup_done';
const ORPHAN_EV_SUPPORT_KEY = 'experimental_ev_support_enabled';
const UNUSABLE_STEPPED_CONFIG_MARKER = 'boot_migrations_v2_unusable_stepped_config_repaired';
// Every marker-gated entry in `BOOT_MIGRATIONS` logs one `boot_migration_applied`
// on a fresh install, whether or not it had anything to change.
const BOOT_MIGRATION_COUNT = 2;
const USABLE_PROFILE = {
  model: 'stepped_load',
  steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 1200 }],
};
const LEGACY_MULTI_HOME_ENABLED = 'multi_home_enabled';
const LEGACY_SUB_HOME = {
  homeId: 'h_legacy',
  name: 'Legacy annex',
  rootZoneId: 'annex',
  meterDeviceId: 'meter-legacy',
};

type MutableHomey = {
  store: Map<string, unknown>;
  homey: Homey.App['homey'];
  unsetCalls: string[];
  setCalls: Array<{ key: string; value: unknown }>;
};

const createHomey = (initial: Record<string, unknown> = {}): MutableHomey => {
  const store = new Map<string, unknown>(Object.entries(initial));
  const unsetCalls: string[] = [];
  const setCalls: Array<{ key: string; value: unknown }> = [];
  const settings = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      setCalls.push({ key, value });
      store.set(key, value);
    },
    unset: (key: string) => {
      unsetCalls.push(key);
      store.delete(key);
    },
    getKeys: () => Array.from(store.keys()),
  };
  return {
    store,
    unsetCalls,
    setCalls,
    homey: { settings } as unknown as Homey.App['homey'],
  };
};

describe('runBootMigrations', () => {
  let capture: LoggerCapture;

  beforeEach(() => {
    capture = captureLogger();
  });

  afterEach(() => {
    capture.restore();
  });

  it('unsets the orphan EV support key and writes the marker on first run', () => {
    const env = createHomey({
      [ORPHAN_EV_SUPPORT_KEY]: true,
    });

    runBootMigrations({ homey: env.homey });

    expect(env.unsetCalls).toEqual([ORPHAN_EV_SUPPORT_KEY]);
    expect(env.store.has(ORPHAN_EV_SUPPORT_KEY)).toBe(false);
    expect(env.store.get(EV_SETTING_CLEANUP_MARKER)).toBe(true);
    expect(capture.findEvents('boot_migration_applied')).toHaveLength(BOOT_MIGRATION_COUNT);
  });

  it('is a no-op on subsequent runs once the marker is set', () => {
    const env = createHomey({
      [ORPHAN_EV_SUPPORT_KEY]: true,
    });

    runBootMigrations({ homey: env.homey });
    env.unsetCalls.length = 0;
    env.setCalls.length = 0;
    capture.events.length = 0;

    // Simulate a stale write of the orphan key happening between boots
    // (e.g. user re-imports settings backup). Migration must remain a no-op
    // because the marker is already set — we don't re-clean keys we already
    // cleaned once.
    env.store.set(ORPHAN_EV_SUPPORT_KEY, true);

    runBootMigrations({ homey: env.homey });

    expect(env.unsetCalls).toEqual([]);
    expect(env.setCalls).toEqual([]);
    expect(capture.findEvent('boot_migration_applied')).toBeUndefined();
  });

  it('still writes the marker on fresh installs where the orphan key was never set', () => {
    const env = createHomey();

    runBootMigrations({ homey: env.homey });

    expect(env.unsetCalls).toEqual([ORPHAN_EV_SUPPORT_KEY]);
    expect(env.store.get(EV_SETTING_CLEANUP_MARKER)).toBe(true);
  });

  it('does not touch managed_devices', () => {
    const managedBefore = { 'device-a': true, 'device-b': false };
    const env = createHomey({
      [ORPHAN_EV_SUPPORT_KEY]: true,
      [MANAGED_DEVICES]: managedBefore,
    });

    runBootMigrations({ homey: env.homey });

    expect(env.unsetCalls).not.toContain(MANAGED_DEVICES);
    expect(env.setCalls.find((call) => call.key === MANAGED_DEVICES)).toBeUndefined();
    expect(env.store.get(MANAGED_DEVICES)).toBe(managedBefore);
  });

  it('idempotently stamps a populated legacy-enabled homes config as GA-active', () => {
    const env = createHomey({
      [EV_SETTING_CLEANUP_MARKER]: true,
      [LEGACY_MULTI_HOME_ENABLED]: true,
      [HOMES_CONFIG_INITIALIZED]: true,
      [HOMES_CONFIG]: { subHomes: [LEGACY_SUB_HOME] },
    });

    runBootMigrations({ homey: env.homey });

    expect(env.store.get(HOMES_CONFIG)).toEqual({
      activationVersion: 1,
      subHomes: [LEGACY_SUB_HOME],
    });
    expect(env.setCalls.filter(({ key }) => key === HOMES_CONFIG)).toHaveLength(1);

    env.setCalls.length = 0;
    runBootMigrations({ homey: env.homey });
    expect(env.setCalls.filter(({ key }) => key === HOMES_CONFIG)).toEqual([]);
  });

  it('drops stepped configurations with no usable ladder and keeps the rest', () => {
    const env = createHomey({
      [ORPHAN_EV_SUPPORT_KEY]: true,
      [DEVICE_CONTROL_PROFILES]: {
        keep: USABLE_PROFILE,
        'drop-empty': { model: 'stepped_load', steps: [] },
        'drop-off-only': { model: 'stepped_load', steps: [{ id: 'off', planningPowerW: 0 }] },
      },
      [DEVICE_TARGET_POWER_CONFIGS]: {
        keep: { enabled: true, max: 3680, step: 460 },
        'drop-no-ladder': { enabled: true, max: 100, step: 500 },
      },
    });

    runBootMigrations({ homey: env.homey });

    // The dropped devices revert to their default control model simply by
    // losing the entry — nothing else is written on their behalf.
    expect(env.store.get(DEVICE_CONTROL_PROFILES)).toEqual({
      keep: USABLE_PROFILE,
    });
    expect(env.store.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual({
      keep: { enabled: true, max: 3680, step: 460 },
    });
    expect(env.store.get(UNUSABLE_STEPPED_CONFIG_MARKER)).toBe(true);
    expect(capture.findEvents('unusable_stepped_configuration_repaired').map((event) => ({
      kind: event.kind,
      droppedDeviceIds: event.droppedDeviceIds,
    }))).toEqual([
      { kind: 'control_profile', droppedDeviceIds: ['drop-empty', 'drop-off-only'] },
      { kind: 'target_power_config', droppedDeviceIds: ['drop-no-ladder'] },
    ]);
  });

  it('leaves healthy stepped configurations untouched', () => {
    const profiles = { keep: USABLE_PROFILE };
    const configs = { keep: { enabled: true, max: 3680, step: 460 } };
    const env = createHomey({
      [DEVICE_CONTROL_PROFILES]: profiles,
      [DEVICE_TARGET_POWER_CONFIGS]: configs,
    });

    runBootMigrations({ homey: env.homey });

    expect(env.setCalls.filter(({ key }) => key === DEVICE_CONTROL_PROFILES)).toEqual([]);
    expect(env.setCalls.filter(({ key }) => key === DEVICE_TARGET_POWER_CONFIGS)).toEqual([]);
    expect(env.store.get(DEVICE_CONTROL_PROFILES)).toBe(profiles);
    expect(env.store.get(DEVICE_TARGET_POWER_CONFIGS)).toBe(configs);
    expect(capture.findEvent('unusable_stepped_configuration_repaired')).toBeUndefined();
  });

  it('retries next boot when a stepped setting the key list vouches for reads empty', () => {
    // A listed key that reads empty is a transient miss, and burning the marker
    // on it is not merely a stale entry: one unusable profile makes the boot
    // guard reject the WHOLE map, so every device loses its stored ladder on
    // every later boot. The repair has to get another chance.
    const env = createHomey({ [DEVICE_CONTROL_PROFILES]: null });

    runBootMigrations({ homey: env.homey });

    expect(env.store.get(UNUSABLE_STEPPED_CONFIG_MARKER)).toBeUndefined();
    expect(capture.findEvent('boot_migration_deferred')).toBeDefined();

    // Next boot, the read succeeds and the repair lands.
    env.store.set(DEVICE_CONTROL_PROFILES, {
      keep: USABLE_PROFILE,
      'drop-me': { model: 'stepped_load', steps: [] },
    });

    runBootMigrations({ homey: env.homey });

    expect(env.store.get(DEVICE_CONTROL_PROFILES)).toEqual({ keep: USABLE_PROFILE });
    expect(env.store.get(UNUSABLE_STEPPED_CONFIG_MARKER)).toBe(true);
  });

  it('repairs a stepped setting that was stored JSON-encoded', () => {
    // Writing through the Homey API's app-setting endpoint stores the value as
    // a JSON string, and the runtime normalizers accept that form. Treating it
    // as unreadable would defer this repair on every boot of such an install.
    const env = createHomey({
      [DEVICE_TARGET_POWER_CONFIGS]: JSON.stringify({
        keep: { enabled: true, max: 3680, step: 460 },
        'drop-no-ladder': { enabled: true, max: 100, step: 500 },
      }),
    });

    runBootMigrations({ homey: env.homey });

    expect(env.store.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual({
      keep: { enabled: true, max: 3680, step: 460 },
    });
    expect(env.store.get(UNUSABLE_STEPPED_CONFIG_MARKER)).toBe(true);
  });

  it('defers instead of aborting boot when the repair write throws', () => {
    // This runs inside a startup step that rethrows, so an escaping write error
    // would take the whole app down rather than skip a cleanup.
    const env = createHomey({
      [DEVICE_CONTROL_PROFILES]: { 'drop-me': { model: 'stepped_load', steps: [] } },
    });
    const originalSet = env.homey.settings.set.bind(env.homey.settings);
    env.homey.settings.set = ((key: string, value: unknown) => {
      if (key === DEVICE_CONTROL_PROFILES) throw new Error('Settings unavailable');
      originalSet(key, value);
    }) as typeof env.homey.settings.set;

    expect(() => runBootMigrations({ homey: env.homey })).not.toThrow();

    expect(env.store.get(UNUSABLE_STEPPED_CONFIG_MARKER)).toBeUndefined();
    expect(capture.findEvent('boot_migration_deferred')).toBeDefined();
  });

  it('treats a key the list never mentions as nothing to repair', () => {
    const env = createHomey();

    runBootMigrations({ homey: env.homey });

    expect(env.store.get(UNUSABLE_STEPPED_CONFIG_MARKER)).toBe(true);
    expect(capture.findEvent('boot_migration_deferred')).toBeUndefined();
  });

  it('does not re-repair a profile the user re-saved after the one-time fix', () => {
    const env = createHomey({
      [DEVICE_CONTROL_PROFILES]: { 'drop-me': { model: 'stepped_load', steps: [] } },
    });

    runBootMigrations({ homey: env.homey });
    expect(env.store.get(DEVICE_CONTROL_PROFILES)).toEqual({});

    // The save paths reject an unusable profile now, so a later one can only
    // come from outside PELS. The marker means the repair does not run again.
    env.store.set(DEVICE_CONTROL_PROFILES, { 'drop-me': { model: 'stepped_load', steps: [] } });
    env.setCalls.length = 0;

    runBootMigrations({ homey: env.homey });

    expect(env.setCalls.filter(({ key }) => key === DEVICE_CONTROL_PROFILES)).toEqual([]);
  });

  it.each([
    ['the historical absent default', undefined],
    ['an explicit false flag', false],
  ])('does not mutate a populated legacy-off config for %s', (_label, flag) => {
    const initial = { subHomes: [LEGACY_SUB_HOME] };
    const env = createHomey({
      [EV_SETTING_CLEANUP_MARKER]: true,
      ...(flag === undefined ? {} : { [LEGACY_MULTI_HOME_ENABLED]: flag }),
      [HOMES_CONFIG_INITIALIZED]: true,
      [HOMES_CONFIG]: initial,
    });

    runBootMigrations({ homey: env.homey });

    expect(env.store.get(HOMES_CONFIG)).toBe(initial);
    expect(env.setCalls.filter(({ key }) => key === HOMES_CONFIG)).toEqual([]);
  });
});
