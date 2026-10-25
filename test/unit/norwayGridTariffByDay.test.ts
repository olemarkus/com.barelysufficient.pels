import { buildCombinedHourlyPricesNorway } from '../../lib/price/priceServiceNorway';

const tariffDay = (dateKey: string, peak: number, night: number) => Array.from({ length: 24 }, (_, time) => ({
  time,
  energyFeeExVat: time >= 6 && time < 22 ? peak : night,
  energyFeeIncVat: (time >= 6 && time < 22 ? peak : night) * 1.25,
  dateKey: `${dateKey}T00:00:00`,
}));

const spotAt = (startsAt: string) => ({ startsAt, spotPriceExVat: 50 });

const gridTariffAt = (prices: ReturnType<typeof buildCombinedHourlyPricesNorway>, startsAt: string): number | undefined => (
  prices.find((price) => Date.parse(price.startsAt) === Date.parse(startsAt))?.gridTariffExVat
);

const build = (gridTariffData: unknown, spotPrices: unknown) => buildCombinedHourlyPricesNorway({
  spotPrices,
  gridTariffData,
  providerSurchargeIncVat: 0,
  priceArea: 'NO2',
  countyCode: '11',
  tariffGroup: 'Husholdning',
  now: new Date('2026-10-25T10:00:00Z'),
  timeZone: 'Europe/Oslo',
});

describe('grid tariff per local day', () => {
  it('prices tomorrow on tomorrow\'s tariff', () => {
    // Sunday flat at the night rate, Monday with the weekday peak.
    const prices = build(
      [...tariffDay('2026-10-25', 14.6, 14.6), ...tariffDay('2026-10-26', 26.6, 14.6)],
      [spotAt('2026-10-25T08:00:00Z'), spotAt('2026-10-26T08:00:00Z')],
    );
    expect(gridTariffAt(prices, '2026-10-25T08:00:00Z')).toBe(14.6);
    expect(gridTariffAt(prices, '2026-10-26T08:00:00Z')).toBe(26.6);
  });

  it('prices a day with no tariff of its own on the latest day before it', () => {
    const prices = build(
      tariffDay('2026-10-25', 26.6, 14.6),
      [spotAt('2026-10-25T08:00:00Z'), spotAt('2026-10-26T08:00:00Z')],
    );
    expect(gridTariffAt(prices, '2026-10-26T08:00:00Z')).toBe(26.6);
  });

  it('uses the local day, not the UTC day, at a local midnight', () => {
    // 2026-10-25T23:30Z is 00:30 on Monday in Oslo: Monday's night rate, not Sunday's.
    const prices = build(
      [...tariffDay('2026-10-25', 14.6, 14.6), ...tariffDay('2026-10-26', 26.6, 13)],
      [spotAt('2026-10-25T23:00:00Z')],
    );
    expect(gridTariffAt(prices, '2026-10-25T23:00:00Z')).toBe(13);
  });

  it('keeps pricing an undated stored tariff by hour', () => {
    const undated = tariffDay('2026-10-25', 26.6, 14.6).map(({ dateKey: _dateKey, ...row }) => row);
    const prices = build(undated, [spotAt('2026-10-26T08:00:00Z')]);
    expect(gridTariffAt(prices, '2026-10-26T08:00:00Z')).toBe(26.6);
  });
});
