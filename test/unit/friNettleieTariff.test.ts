import { readFriNettleieTariffs } from '../../lib/price/friNettleieTariff';

const period = (from: string, until: string | undefined, grunnpris: number, extra: Record<string, unknown> = {}) => ({
  kundegrupper: ['husholdning'],
  energiledd: { grunnpris, ...extra },
  gyldig_fra: from,
  ...(until ? { gyldig_til: until } : {}),
});

describe('readFriNettleieTariffs', () => {
  it('keeps the current and future periods, oldest first, and drops ended ones', () => {
    const tariffs = readFriNettleieTariffs({
      tariffer: [
        period('2027-01-01', undefined, 30),
        period('2025-01-01', '2026-07-01', 10),
        period('2026-07-01', '2027-01-01', 20),
      ],
    }, '2026-11-02');
    expect(tariffs?.Husholdning?.map(({ from, until, basePrice }) => ({ from, until, basePrice }))).toEqual([
      { from: '2026-07-01', until: '2027-01-01', basePrice: 20 },
      { from: '2027-01-01', until: undefined, basePrice: 30 },
    ]);
    expect(tariffs?.['Hytter og fritidshus']).toBeUndefined();
  });

  it('reads exception hours, months and day types', () => {
    const tariffs = readFriNettleieTariffs({
      tariffer: [period('2026-01-01', undefined, 10, {
        unntak: [
          { navn: 'Dag', timer: ['6-8', 17], dager: ['Virkedag'], måneder: ['januar', 'februar'], pris: 20 },
          { navn: 'Hele døgnet', pris: 5 },
          { navn: 'Uten pris', timer: '1' },
        ],
      })],
    }, '2026-11-02');
    expect(tariffs?.Husholdning?.[0]?.exceptions).toEqual([
      { hours: [6, 7, 8, 17], price: 20, months: [1, 2], dayTypes: ['virkedag'] },
      { hours: Array.from({ length: 24 }, (_, hour) => hour), price: 5 },
    ]);
  });

  it('clamps an hour range to the day', () => {
    const tariffs = readFriNettleieTariffs({
      tariffer: [period('2026-01-01', undefined, 10, { unntak: [{ navn: 'Kveld', timer: '20-99999999', pris: 20 }] })],
    }, '2026-11-02');
    expect(tariffs?.Husholdning?.[0]?.exceptions[0]?.hours).toEqual([20, 21, 22, 23]);
  });

  it('drops a period with an implausible fee', () => {
    expect(readFriNettleieTariffs({ tariffer: [period('2026-01-01', undefined, 9000)] }, '2026-11-02')).toBeNull();
    expect(readFriNettleieTariffs({
      tariffer: [period('2026-01-01', undefined, 10, { unntak: [{ navn: 'Dag', timer: '6-21', pris: -500 }] })],
    }, '2026-11-02')).toBeNull();
  });

  it('is null for a document that holds no usable period', () => {
    expect(readFriNettleieTariffs(null, '2026-11-02')).toBeNull();
    expect(readFriNettleieTariffs({ tariffer: [period('2025-01-01', '2026-01-01', 10)] }, '2026-11-02')).toBeNull();
    expect(readFriNettleieTariffs({ tariffer: [{ kundegrupper: ['husholdning'], energiledd: { grunnpris: 1 } }] }, '2026-11-02'))
      .toBeNull();
  });
});
