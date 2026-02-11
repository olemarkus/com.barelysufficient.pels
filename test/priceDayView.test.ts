import type { CombinedPriceData, PriceEntry } from '../settings/src/ui/priceTypes';

const buildPriceDayDom = () => {
  document.body.innerHTML = `
    <h3 id="price-day-title"></h3>
    <p id="price-day-label"></p>
    <div id="price-day-status-pill"></div>
    <button id="price-day-toggle-today"></button>
    <button id="price-day-toggle-tomorrow"></button>
    <span id="price-day-now-label"></span>
    <span id="price-day-now"></span>
    <span id="price-day-avg"></span>
    <span id="price-day-range"></span>
    <div id="price-day-chart"><div id="price-day-bars"></div><div id="price-day-labels"></div></div>
    <div id="price-day-legend"></div>
    <p id="price-day-empty" hidden></p>
    <p id="price-day-meta"></p>
  `;
};

const setTimezone = (timeZone: string) => {
  const { setHomeyClient } = require('../settings/src/ui/homey') as typeof import('../settings/src/ui/homey');
  setHomeyClient({
    clock: {
      getTimezone: () => timeZone,
    },
  } as any);
};

const buildCombined = (prices: PriceEntry[]): CombinedPriceData => {
  const avgPrice = prices.reduce((sum, price) => sum + price.total, 0) / prices.length;
  return {
    prices,
    avgPrice,
    lowThreshold: avgPrice * 0.75,
    highThreshold: avgPrice * 1.25,
    priceScheme: 'norway',
    priceUnit: 'ore/kWh',
  };
};

describe('price day view', () => {
  beforeEach(() => {
    jest.resetModules();
    buildPriceDayDom();
  });

  afterEach(() => {
    const { setHomeyClient } = require('../settings/src/ui/homey') as typeof import('../settings/src/ui/homey');
    setHomeyClient(null);
    jest.useRealTimers();
  });

  it('keeps today state when only tomorrow data exists', () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-06T12:00:00.000Z'));
    setTimezone('UTC');

    const { renderPriceDayView } = require('../settings/src/ui/priceDayView') as typeof import('../settings/src/ui/priceDayView');
    const tomorrowPrices: PriceEntry[] = [{
      startsAt: '2025-01-07T00:00:00.000Z',
      total: 121.5,
    }];
    renderPriceDayView(buildCombined(tomorrowPrices));

    const title = document.querySelector('#price-day-title') as HTMLElement;
    const status = document.querySelector('#price-day-status-pill') as HTMLElement;
    const chart = document.querySelector('#price-day-chart') as HTMLElement;
    const empty = document.querySelector('#price-day-empty') as HTMLElement;
    const todayButton = document.querySelector('#price-day-toggle-today') as HTMLButtonElement;

    expect(title.textContent).toBe('Today prices');
    expect(status.textContent).toBe('No data');
    expect(chart.hidden).toBe(true);
    expect(empty.hidden).toBe(false);
    expect(todayButton.getAttribute('aria-pressed')).toBe('true');
  });
});
