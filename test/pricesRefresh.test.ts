import type { CombinedPriceData, PriceEntry } from '../settings/src/ui/priceTypes';

jest.mock('../settings/src/ui/homey', () => ({
  getSetting: jest.fn(),
  getHomeyTimezone: jest.fn(() => 'UTC'),
  setSetting: jest.fn(),
}));

jest.mock('../settings/src/ui/priceRender', () => ({
  renderPrices: jest.fn(),
}));

jest.mock('../settings/src/ui/priceDayView', () => ({
  renderPriceDayView: jest.fn(),
}));

jest.mock('../settings/src/ui/logging', () => ({
  logSettingsError: jest.fn().mockResolvedValue(undefined),
}));

const buildDom = () => {
  document.body.innerHTML = `
    <div id="price-status-badge"></div>
    <div id="price-flow-status"></div>
    <span id="price-flow-enabled"></span>
    <span id="price-flow-today"></span>
    <span id="price-flow-tomorrow"></span>
    <div id="price-homey-status"></div>
    <span id="price-homey-enabled"></span>
    <span id="price-homey-currency"></span>
    <span id="price-homey-today"></span>
    <span id="price-homey-tomorrow"></span>
  `;
};

const getMocks = () => ({
  homey: jest.requireMock('../settings/src/ui/homey') as {
    getSetting: jest.Mock;
  },
  render: jest.requireMock('../settings/src/ui/priceRender') as {
    renderPrices: jest.Mock;
  },
  dayView: jest.requireMock('../settings/src/ui/priceDayView') as {
    renderPriceDayView: jest.Mock;
  },
  logging: jest.requireMock('../settings/src/ui/logging') as {
    logSettingsError: jest.Mock;
  },
});

describe('refreshPrices', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    buildDom();
  });

  it('does not clear day view when Homey status refresh fails', async () => {
    const { homey, render, dayView, logging } = getMocks();

    const prices: PriceEntry[] = [{
      startsAt: '2025-01-06T12:00:00.000Z',
      total: 121.5,
    }];
    const combined: CombinedPriceData = {
      prices,
      avgPrice: 121.5,
      lowThreshold: 100,
      highThreshold: 140,
      priceScheme: 'homey',
      priceUnit: 'NOK/kWh',
    };

    homey.getSetting.mockImplementation(async (key: string) => {
      switch (key) {
        case 'price_scheme':
          return 'homey';
        case 'homey_prices_currency':
          return 'NOK/kWh';
        case 'combined_prices':
          return combined;
        case 'homey_prices_today':
          throw new Error('homey status fetch failed');
        case 'homey_prices_tomorrow':
          return null;
        default:
          return null;
      }
    });

    const { refreshPrices } = require('../settings/src/ui/prices') as typeof import('../settings/src/ui/prices');
    await refreshPrices();

    expect(render.renderPrices).toHaveBeenCalledTimes(1);
    expect(dayView.renderPriceDayView).toHaveBeenCalledTimes(1);
    expect(dayView.renderPriceDayView).toHaveBeenCalledWith(expect.objectContaining({
      prices,
      priceScheme: 'homey',
    }));
    expect(dayView.renderPriceDayView).not.toHaveBeenCalledWith(null);
    expect(logging.logSettingsError).toHaveBeenCalledWith(
      'Failed to refresh Homey price status',
      expect.any(Error),
      'refreshHomeyStatus',
    );
  });

  it('renders empty price views without errors when price feature data is unavailable', async () => {
    const { homey, render, dayView, logging } = getMocks();

    homey.getSetting.mockImplementation(async (key: string) => {
      switch (key) {
        case 'price_scheme':
          return 'homey';
        case 'homey_prices_currency':
          return null;
        case 'combined_prices':
          return null;
        case 'homey_prices_today':
        case 'homey_prices_tomorrow':
          return null;
        default:
          return null;
      }
    });

    const { refreshPrices } = require('../settings/src/ui/prices') as typeof import('../settings/src/ui/prices');
    await refreshPrices();

    expect(render.renderPrices).toHaveBeenCalledWith(null);
    expect(dayView.renderPriceDayView).toHaveBeenCalledWith(null);
    expect(logging.logSettingsError).not.toHaveBeenCalled();
  });
});
