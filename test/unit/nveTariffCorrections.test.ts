import { correctNveGridTariffDay } from '../../lib/price/nveTariffCorrections';

const LNETT = '980038408';
const ELVIA = '980489698';

// One day of normalized NVE rows as NVE serves Lnett: 26.6 on 06–22, 14.6 otherwise, every day.
const lnettDay = (dateKey: string): Array<Record<string, unknown>> => Array.from({ length: 24 }, (_, time) => {
  const fee = time >= 6 && time < 22 ? 26.6 : 14.6;
  return { time, energyFeeExVat: fee, energyFeeIncVat: fee * 1.25, dateKey: `${dateKey}T00:00:00` };
});

describe('correctNveGridTariffDay', () => {
  it('prices every Lnett weekend hour at the night rate', () => {
    for (const weekend of ['2026-10-24', '2026-10-25']) {
      const corrected = correctNveGridTariffDay(lnettDay(weekend), LNETT, weekend);
      expect(corrected.map((row) => row.energyFeeExVat)).toEqual(new Array(24).fill(14.6));
      expect(corrected.map((row) => row.energyFeeIncVat)).toEqual(new Array(24).fill(14.6 * 1.25));
      expect(corrected.map((row) => row.time)).toEqual(Array.from({ length: 24 }, (_, h) => h));
    }
  });

  it('leaves an Lnett weekday as NVE serves it', () => {
    const monday = lnettDay('2026-10-26');
    expect(correctNveGridTariffDay(monday, LNETT, '2026-10-26')).toEqual(monday);
  });

  it('leaves other grid companies as NVE serves them, weekend or not', () => {
    const bkkSunday = lnettDay('2026-10-25');
    expect(correctNveGridTariffDay(bkkSunday, '976944801', '2026-10-25')).toEqual(bkkSunday);
  });
});

// One day of normalized NVE rows as NVE serves Elvia: its January 2026 rates, 21.99/13.99 ex VAT.
const elviaDay = (dateKey: string, nightOnly = false): Array<Record<string, unknown>> => (
  Array.from({ length: 24 }, (_, time) => {
    const day = !nightOnly && time >= 6 && time < 22;
    return {
      time,
      energyFeeExVat: day ? 21.99 : 13.99,
      energyFeeIncVat: day ? 36.4 : 26.4,
      dateKey: `${dateKey}T00:00:00`,
    };
  })
);

describe('correctNveGridTariffDay for Elvia', () => {
  it('prices Elvia at its July 2026 rates', () => {
    const corrected = correctNveGridTariffDay(elviaDay('2026-11-02'), ELVIA, '2026-11-02');
    expect(corrected[3]).toMatchObject({ energyFeeExVat: 17.99, energyFeeIncVat: 31.4, time: 3 });
    expect(corrected[12]).toMatchObject({ energyFeeExVat: 30, energyFeeIncVat: 46.4, time: 12 });
  });

  it('prices an Elvia weekend at the July night rate', () => {
    const corrected = correctNveGridTariffDay(elviaDay('2026-11-01', true), ELVIA, '2026-11-01');
    expect(corrected.map((row) => row.energyFeeExVat)).toEqual(new Array(24).fill(17.99));
  });

  it('leaves Elvia as NVE serves it before July 2026 and after 2026', () => {
    for (const dateKey of ['2026-06-30', '2027-01-04']) {
      const day = elviaDay(dateKey);
      expect(correctNveGridTariffDay(day, ELVIA, dateKey)).toEqual(day);
    }
  });

  it('leaves an Elvia rate NVE has already corrected', () => {
    const corrected = elviaDay('2026-11-02').map((row) => ({ ...row, energyFeeExVat: 30, energyFeeIncVat: 46.4 }));
    expect(correctNveGridTariffDay(corrected, ELVIA, '2026-11-02')).toEqual(corrected);
  });
});
