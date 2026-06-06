import type Homey from 'homey';
import { runBootMigrations } from '../../setup/appBootMigrations';
import { MANAGED_DEVICES } from '../../lib/utils/settingsKeys';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

const EV_SETTING_CLEANUP_MARKER = 'boot_migrations_v1_ev_setting_cleanup_done';
const ORPHAN_EV_SUPPORT_KEY = 'experimental_ev_support_enabled';

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
});
