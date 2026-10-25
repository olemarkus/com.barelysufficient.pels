import { normalizeGridTariffData, oneGridTariffEntryPerHour } from '../../lib/price/gridTariffUtils';

describe('oneGridTariffEntryPerHour', () => {
  it('keeps the last entry for each hour, in first-seen hour order', () => {
    // The reader of the stored tariff (`buildGridTariffByDay`) lets the last
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

describe('oneGridTariffEntryPerHour across days', () => {
  it('keeps the same hour on two days apart', () => {
    expect(oneGridTariffEntryPerHour([
      { time: 6, energyFeeExVat: 26, dateKey: '2026-10-23T00:00:00' },
      { time: 6, energyFeeExVat: 14, dateKey: '2026-10-24T00:00:00' },
    ])).toHaveLength(2);
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
    expect(normalizeGridTariffData(nve, '2026-09-27')).toEqual([
      { time: 0, energyFeeExVat: 20, energyFeeIncVat: 25, dateKey: '2026-09-27T00:00:00' },
      { time: 1, energyFeeExVat: 21, energyFeeIncVat: 26, dateKey: '2026-09-27T00:00:00' },
    ]);
  });
});

describe('normalizeGridTariffData dating', () => {
  it('dates the rows with the day they were requested for', () => {
    const rows = normalizeGridTariffData([{ time: 0, energileddEks: 10, energileddInk: 12.5 }], '2026-10-26');
    expect(rows).toEqual([{ time: 0, energyFeeExVat: 10, energyFeeIncVat: 12.5, dateKey: '2026-10-26T00:00:00' }]);
  });
});
