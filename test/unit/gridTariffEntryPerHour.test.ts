import { normalizeGridTariffData, oneGridTariffEntryPerHour } from '../../lib/price/gridTariffUtils';

describe('oneGridTariffEntryPerHour', () => {
  it('keeps the last entry for each hour, in first-seen hour order', () => {
    // The reader of the stored tariff (`buildGridTariffByHour`) lets the last
    // row of an hour win, so keeping that row changes no price.
    expect(oneGridTariffEntryPerHour([
      { time: 1, energyFeeExVat: 5 },
      { time: 0, energyFeeExVat: 7 },
      { time: 1, energyFeeExVat: 6 },
    ])).toEqual([{ time: 1, energyFeeExVat: 6 }, { time: 0, energyFeeExVat: 7 }]);
  });

  it('keeps the last row that carries a fee over a later one that does not', () => {
    // The reader skips a row with no fee, so that row must not replace one it would use.
    expect(oneGridTariffEntryPerHour([
      { time: 3, energyFeeExVat: 9 },
      { time: 3 },
      { time: 4 },
      { time: 4 },
    ])).toEqual([{ time: 3, energyFeeExVat: 9 }, { time: 4 }]);
  });
});

describe('normalizeGridTariffData', () => {
  it('stores one row per hour from NVE rows that repeat each hour per capacity step, without the fixed fee', () => {
    const nve = [0, 1].flatMap((time) => [0, 1, 2].map((step) => ({
      time,
      energileddEks: 20 + time,
      energileddInk: 25 + time,
      fastleddEks: 100 * step,
      fastleddInk: 125 * step,
      datoId: '2026-09-27T00:00:00',
    })));
    expect(normalizeGridTariffData(nve)).toEqual([
      { time: 0, energyFeeExVat: 20, energyFeeIncVat: 25, dateKey: '2026-09-27T00:00:00' },
      { time: 1, energyFeeExVat: 21, energyFeeIncVat: 26, dateKey: '2026-09-27T00:00:00' },
    ]);
  });
});
