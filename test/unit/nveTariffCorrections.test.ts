import { correctNveGridTariffDay } from '../../lib/price/nveTariffCorrections';

const LNETT = '980038408';

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
    const elviaSunday = lnettDay('2026-10-25');
    expect(correctNveGridTariffDay(elviaSunday, '980489698', '2026-10-25')).toEqual(elviaSunday);
  });
});
