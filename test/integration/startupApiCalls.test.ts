import type { MockInstance } from 'vitest';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { mockHomeyInstance, MockDevice, MockDriver, setMockDrivers } from '../mocks/homey';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import { PRICE_SCHEME } from '../../lib/utils/settingsKeys';

describe('startup API calls', () => {
  let fetchDynamicPricesSpy: MockInstance | null = null;
  let liveReportSpy: MockInstance | null = null;

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({});
    vi.clearAllMocks();
    fetchDynamicPricesSpy = null;
    liveReportSpy = null;
  });

  afterEach(async () => {
    await cleanupApps();
    // Restore only the spies this spec owns (afterEach runs even on failure) — not
    // vi.restoreAllMocks(), which would also tear down the global console spies that
    // test/setup.ts installs in beforeAll and never re-installs per test.
    fetchDynamicPricesSpy?.mockRestore();
    fetchDynamicPricesSpy = null;
    liveReportSpy?.mockRestore();
    liveReportSpy = null;
    vi.clearAllMocks();
  });

  it('does not fetch dynamic electricity prices during startup for non-Homey schemes', async () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    fetchDynamicPricesSpy = vi.spyOn(mockHomeyInstance.api.energy, 'fetchDynamicElectricityPrices');

    const app = createApp();
    await app.onInit();

    expect(fetchDynamicPricesSpy).not.toHaveBeenCalled();
  });

  it('fetches Homey dynamic prices only for today and tomorrow during startup', async () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    fetchDynamicPricesSpy = vi.spyOn(mockHomeyInstance.api.energy, 'fetchDynamicElectricityPrices');

    const app = createApp();
    await app.onInit();

    expect(fetchDynamicPricesSpy).toHaveBeenCalledTimes(2);
  });

  // The startup bootstrap snapshot runs with { fast: true, recordHomeyEnergySample: false }
  // (lib/app/appLifecycleHelpers.ts), so it must not hit the Homey Energy live report — that
  // poll belongs to the periodic source, not the boot path. Guards against a regression where
  // startup pays the live-fetch cost (the behavioural half of the deleted perf reproduction).
  it('does not fetch the Homey Energy live report during the startup bootstrap snapshot', async () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    setMockDrivers({
      driverA: new MockDriver('driverA', [
        new MockDevice('dev-1', 'Socket', ['onoff', 'measure_power'], 'socket'),
      ]),
    });
    liveReportSpy = vi.spyOn(homeyApi, 'getEnergyLiveReport');

    const app = createApp();
    await app.onInit();

    expect(liveReportSpy).not.toHaveBeenCalled();
  });
});
