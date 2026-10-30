import { readHubMarket } from '../../lib/home/hubMarket';
import { CapacityMarketDefault } from '../../lib/power/capacityMarketDefault';
import { CAPACITY_ENABLED } from '../../lib/utils/settingsKeys';
import { classifyInstallAtBoot, type InstallAtBoot } from '../../lib/utils/settingsKeyList';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { SettingsUiHubMarketRead } from '../../packages/contracts/src/settingsUiApi';
import { homeyWebApiServing } from '../helpers/homeyWebApiStub';
import { MockSettings } from '../mocks/homey';

// What a new install's store holds by the time the default runs: the keys this
// boot's own startup steps wrote, never the Capacity limit switch.
const NEW_INSTALL_KEYS = { boot_migrations_v2_unusable_stepped_config_repaired: true };

const settingsWith = (initial: Record<string, unknown>): MockSettings => {
  const settings = new MockSettings();
  for (const [key, value] of Object.entries(initial)) settings.set(key, value);
  return settings;
};

const hubIn = (country: string) => homeyWebApiServing({ 'manager/system': { country } });

const start = (
  settings: MockSettings,
  readMarket: () => Promise<SettingsUiHubMarketRead>,
  installAtBoot: InstallAtBoot = 'new',
): TimerRegistry => {
  const timers = new TimerRegistry();
  new CapacityMarketDefault({ installAtBoot, settings, readHubMarket: readMarket, timers }).start();
  return timers;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyInstallAtBoot', () => {
  it('calls a boot that finds no keys at all a new install', () => {
    expect(classifyInstallAtBoot(new MockSettings())).toBe('new');
  });

  it('calls a boot that finds any key an existing install', () => {
    expect(classifyInstallAtBoot(settingsWith({ setup_notification_handled: true }))).toBe('existing');
  });

  it('changes nothing when the key list cannot be read', () => {
    expect(classifyInstallAtBoot({ getKeys: () => { throw new Error('store unavailable'); } })).toBe('existing');
  });
});

describe('the Capacity limit default on a new install', () => {
  it.each(['NL', 'DE', 'SE', 'FR'])('turns Capacity limit off for a hub in %s', async (country) => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const written: string[] = [];
    settings.on('set', (key: string) => written.push(key));
    const api = hubIn(country);
    const timers = start(settings, () => readHubMarket(api.get));

    await vi.advanceTimersByTimeAsync(0);

    expect(settings.get(CAPACITY_ENABLED)).toBe(false);
    expect(written).toEqual([CAPACITY_ENABLED]);
    expect(api.requestedPaths).toEqual(['manager/system']);
    expect(timers.has('capacityMarketDefault')).toBe(false);
  });

  it('decides from the switch itself while the store of a new install is still empty', async () => {
    const empty = new MockSettings();
    const api = hubIn('DE');
    start(empty, () => readHubMarket(api.get));

    await vi.advanceTimersByTimeAsync(0);

    expect(empty.get(CAPACITY_ENABLED)).toBe(false);
  });

  it('asks again while the key list cannot be read, and decides once it can', async () => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const written: string[] = [];
    settings.on('set', (key: string) => written.push(key));
    const getKeys = vi.spyOn(settings, 'getKeys').mockImplementation(() => { throw new Error('store unavailable'); });
    const api = hubIn('DE');
    start(settings, () => readHubMarket(api.get));

    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual([]);

    getKeys.mockRestore();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(settings.get(CAPACITY_ENABLED)).toBe(false);
  });

  it.each(['NO', 'BE'])('leaves the built-in default on for a hub in %s', async (country) => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const api = hubIn(country);
    const timers = start(settings, () => readHubMarket(api.get));

    await vi.advanceTimersByTimeAsync(0);

    expect(settings.getKeys()).not.toContain(CAPACITY_ENABLED);
    expect(timers.has('capacityMarketDefault')).toBe(false);
  });

  it('never touches an existing install, and never asks where the hub is', async () => {
    const settings = settingsWith({ setup_notification_handled: true });
    const api = hubIn('NL');
    const timers = start(settings, () => readHubMarket(api.get), 'existing');

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(settings.getKeys()).not.toContain(CAPACITY_ENABLED);
    expect(api.requestedPaths).toEqual([]);
    expect(timers.has('capacityMarketDefault')).toBe(false);
  });

  it('keeps a switch the owner already set', async () => {
    const settings = settingsWith({ ...NEW_INSTALL_KEYS, [CAPACITY_ENABLED]: true });
    const api = hubIn('NL');
    start(settings, () => readHubMarket(api.get));

    await vi.advanceTimersByTimeAsync(0);

    expect(settings.get(CAPACITY_ENABLED)).toBe(true);
    expect(api.requestedPaths).toEqual([]);
  });

  it('keeps a switch the owner set while the country was being read', async () => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const api = hubIn('NL');
    start(settings, async () => {
      settings.set(CAPACITY_ENABLED, true);
      return readHubMarket(api.get);
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(settings.get(CAPACITY_ENABLED)).toBe(true);
  });

  it('asks again while the country is unavailable, and settles once Homey answers', async () => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    let answers: Readonly<Record<string, unknown>> = {};
    const reads: string[] = [];
    start(settings, () => readHubMarket(async (path) => {
      reads.push(path);
      return homeyWebApiServing(answers).get(path);
    }));

    await vi.advanceTimersByTimeAsync(0);
    expect(settings.getKeys()).not.toContain(CAPACITY_ENABLED);

    answers = { 'manager/system': { country: 'NL' } };
    await vi.advanceTimersByTimeAsync(30_000);

    expect(settings.get(CAPACITY_ENABLED)).toBe(false);
    expect(reads).toHaveLength(2);
  });

  it('gives up after about ten minutes and leaves the built-in default', async () => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const api = homeyWebApiServing({});
    const timers = start(settings, () => readHubMarket(api.get));

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(api.requestedPaths).toHaveLength(20);
    expect(settings.getKeys()).not.toContain(CAPACITY_ENABLED);
    expect(timers.has('capacityMarketDefault')).toBe(false);
  });

  it('writes nothing when the app stops while the country is being read', async () => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const api = hubIn('NL');
    const timers = new TimerRegistry();
    new CapacityMarketDefault({
      installAtBoot: 'new',
      settings,
      readHubMarket: async () => {
        timers.clearAll();
        return readHubMarket(api.get);
      },
      timers,
    }).start();

    await vi.advanceTimersByTimeAsync(0);

    expect(settings.getKeys()).not.toContain(CAPACITY_ENABLED);
  });
});
