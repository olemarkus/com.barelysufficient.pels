import { createApp, cleanupApps } from './utils/appTestUtils';
import { mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { PRICE_SCHEME } from '../lib/utils/settingsKeys';

describe('startup API calls', () => {
  let fetchDynamicPricesSpy: jest.SpyInstance | null = null;

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({});
    jest.clearAllMocks();
    fetchDynamicPricesSpy = null;
  });

  afterEach(async () => {
    await cleanupApps();
    fetchDynamicPricesSpy?.mockRestore();
    fetchDynamicPricesSpy = null;
    jest.clearAllMocks();
  });

  it('does not fetch dynamic electricity prices during startup for non-Homey schemes', async () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    fetchDynamicPricesSpy = jest.spyOn(mockHomeyInstance.api.energy, 'fetchDynamicElectricityPrices');

    const app = createApp();
    await app.onInit();

    expect(fetchDynamicPricesSpy).not.toHaveBeenCalled();
  });

  it('fetches Homey dynamic prices only for today and tomorrow during startup', async () => {
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    fetchDynamicPricesSpy = jest.spyOn(mockHomeyInstance.api.energy, 'fetchDynamicElectricityPrices');

    const app = createApp();
    await app.onInit();

    expect(fetchDynamicPricesSpy).toHaveBeenCalledTimes(2);
  });
});
