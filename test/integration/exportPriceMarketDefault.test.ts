import { readHubMarket } from '../../lib/home/hubMarket';
import { ExportPriceMarketDefault } from '../../lib/price/exportPriceMarketDefault';
import { EXPORT_PRICE_ENABLED, EXPORT_PRICE_SOURCE } from '../../lib/utils/settingsKeys';
import type { InstallAtBoot } from '../../lib/utils/settingsKeyList';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { SettingsUiHubMarketRead } from '../../packages/contracts/src/settingsUiApi';
import { homeyWebApiServing } from '../helpers/homeyWebApiStub';
import { MockSettings } from '../mocks/homey';

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
  new ExportPriceMarketDefault({ installAtBoot, settings, readHubMarket: readMarket, timers }).start();
  return timers;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ExportPriceMarketDefault', () => {
  it('prices a new Dutch install\'s export from Homey Energy\'s feed-in terms', async () => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const written: string[] = [];
    settings.on('set', (key: string) => written.push(key));
    const api = hubIn('NL');
    const timers = start(settings, () => readHubMarket(api.get));

    await vi.advanceTimersByTimeAsync(0);

    expect(settings.get(EXPORT_PRICE_SOURCE)).toBe('homey_energy');
    expect(settings.get(EXPORT_PRICE_ENABLED)).toBe(true);
    expect(written).toEqual([EXPORT_PRICE_SOURCE, EXPORT_PRICE_ENABLED]);
    expect(timers.has('exportPriceMarketDefault')).toBe(false);
  });

  it.each(['NO', 'BE', 'SE'])('writes nothing for a new install in %s', async (country) => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const api = hubIn(country);
    start(settings, () => readHubMarket(api.get));

    await vi.advanceTimersByTimeAsync(0);

    expect(settings.getKeys()).not.toContain(EXPORT_PRICE_ENABLED);
    expect(settings.getKeys()).not.toContain(EXPORT_PRICE_SOURCE);
  });

  it('keeps an export choice the owner made while the country was being read', async () => {
    const settings = settingsWith(NEW_INSTALL_KEYS);
    const api = hubIn('NL');
    start(settings, async () => {
      settings.set(EXPORT_PRICE_ENABLED, false);
      return readHubMarket(api.get);
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(settings.get(EXPORT_PRICE_ENABLED)).toBe(false);
    expect(settings.getKeys()).not.toContain(EXPORT_PRICE_SOURCE);
  });

  it('never touches an existing Dutch install, and never asks where the hub is', async () => {
    const settings = settingsWith({ setup_notification_handled: true });
    const api = hubIn('NL');
    start(settings, () => readHubMarket(api.get), 'existing');

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(settings.getKeys()).not.toContain(EXPORT_PRICE_ENABLED);
    expect(api.requestedPaths).toEqual([]);
  });
});
