import type Homey from 'homey';
import { runBootMigrations } from '../../setup/appBootMigrations';
import {
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  MANAGED_DEVICES,
} from '../../lib/utils/settingsKeys';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

const EV_SETTING_CLEANUP_MARKER = 'boot_migrations_v1_ev_setting_cleanup_done';
const ORPHAN_EV_SUPPORT_KEY = 'experimental_ev_support_enabled';
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
    expect(capture.findEvents('boot_migration_applied')).toHaveLength(1);
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
