import type { CombinedPriceData, PriceEntry } from '../settings/src/ui/priceTypes';

const buildDayPrices = (year: number, monthIndex: number, day: number): PriceEntry[] => (
  Array.from({ length: 24 }, (_, hour) => ({
    startsAt: new Date(Date.UTC(year, monthIndex, day, hour, 0, 0, 0)).toISOString(),
    total: 10 + hour,
  }))
);

const buildCombined = (prices: PriceEntry[]): CombinedPriceData => {
  const avgPrice = prices.reduce((sum, price) => sum + price.total, 0) / prices.length;
  return {
    prices,
    avgPrice,
    lowThreshold: avgPrice * 0.75,
    highThreshold: avgPrice * 1.25,
  };
};

const setupDom = () => {
  document.body.innerHTML = `
    <div id="price-status-badge"></div>
    <div id="price-list" class="device-list" role="list"></div>
    <p id="price-empty" hidden></p>
  `;
};

describe('price rendering', () => {
  beforeEach(() => {
    jest.resetModules();
    setupDom();
  });

  afterEach(() => {
    const { setHomeyClient } = require('../settings/src/ui/homey') as typeof import('../settings/src/ui/homey');
    setHomeyClient(null);
    jest.useRealTimers();
  });

  test('shows all hours for today, including past hours', () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-02T12:30:00Z'));

    const { setHomeyClient } = require('../settings/src/ui/homey') as typeof import('../settings/src/ui/homey');
    setHomeyClient({ clock: { getTimezone: () => 'UTC' } } as any);
    const { renderPrices } = require('../settings/src/ui/priceRender') as typeof import('../settings/src/ui/priceRender');

    const prices = buildDayPrices(2025, 0, 2);
    renderPrices(buildCombined(prices));

    const summaries = Array.from(document.querySelectorAll('.price-details summary'))
      .map((el) => el.textContent || '');
    expect(summaries.some((text) => text.includes('Today') && text.includes('24 hours'))).toBe(true);

    const timeLabels = Array.from(document.querySelectorAll('.price-row .device-row__name'))
      .map((el) => el.textContent || '');
    expect(timeLabels.some((label) => label.includes('02:00'))).toBe(true);

    const nowBadge = document.querySelector('.price-now-badge');
    expect(nowBadge?.textContent).toBe('Now');
  });

  test('shows norgespris adjustment in tooltip when present', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-15T10:15:00Z'));

    const { setHomeyClient } = require('../settings/src/ui/homey') as typeof import('../settings/src/ui/homey');
    setHomeyClient({ clock: { getTimezone: () => 'UTC' } } as any);
    const { renderPrices } = require('../settings/src/ui/priceRender') as typeof import('../settings/src/ui/priceRender');

    const currentHourStart = new Date('2026-01-15T10:00:00.000Z').toISOString();
    const entry = {
      startsAt: currentHourStart,
      total: 95.2,
      spotPriceExVat: 160,
      gridTariffExVat: 28,
      providerSurchargeExVat: 0,
      consumptionTaxExVat: 7.13,
      enovaFeeExVat: 1,
      vatMultiplier: 1.25,
      vatAmount: 49.03,
      totalExVat: 196.13,
      norgesprisAdjustment: -150,
      electricitySupport: 0,
    } as PriceEntry;
    const data: CombinedPriceData = {
      prices: [entry],
      avgPrice: 95.2,
      lowThreshold: 80,
      highThreshold: 110,
      priceScheme: 'norway',
      priceUnit: 'øre/kWh',
    };

    renderPrices(data);

    const chip = document.querySelector('.price-row .chip') as HTMLElement | null;
    expect(chip?.dataset.tooltip).toContain('Norway Price adjustment: -150.0 øre');
    expect(chip?.dataset.tooltip).not.toContain('Electricity subsidy:');
  });

  test('shows electricity support in tooltip when norgespris adjustment is absent', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-15T10:15:00Z'));

    const { setHomeyClient } = require('../settings/src/ui/homey') as typeof import('../settings/src/ui/homey');
    setHomeyClient({ clock: { getTimezone: () => 'UTC' } } as any);
    const { renderPrices } = require('../settings/src/ui/priceRender') as typeof import('../settings/src/ui/priceRender');

    const currentHourStart = new Date('2026-01-15T10:00:00.000Z').toISOString();
    const entry = {
      startsAt: currentHourStart,
      total: 145.2,
      spotPriceExVat: 160,
      gridTariffExVat: 28,
      providerSurchargeExVat: 0,
      consumptionTaxExVat: 7.13,
      enovaFeeExVat: 1,
      vatMultiplier: 1.25,
      vatAmount: 49.03,
      totalExVat: 196.13,
      electricitySupport: 50,
    } as PriceEntry;
    const data: CombinedPriceData = {
      prices: [entry],
      avgPrice: 145.2,
      lowThreshold: 80,
      highThreshold: 110,
      priceScheme: 'norway',
      priceUnit: 'øre/kWh',
    };

    renderPrices(data);

    const chip = document.querySelector('.price-row .chip') as HTMLElement | null;
    expect(chip?.dataset.tooltip).toContain('Electricity subsidy: -50.0 øre');
    expect(chip?.dataset.tooltip).not.toContain('Norway Price adjustment:');
  });
});
