import { readFriNettleieTariffs } from '../../lib/price/friNettleieTariff';

const tariffsOf = (read: ReturnType<typeof readFriNettleieTariffs>) => (read.kind === 'tariffs' ? read.tariffs : null);

const period = (from: string, until: string | undefined, grunnpris: number, extra: Record<string, unknown> = {}) => ({
  kundegrupper: ['husholdning'],
  energiledd: { grunnpris, ...extra },
  gyldig_fra: from,
  ...(until ? { gyldig_til: until } : {}),
});

describe('readFriNettleieTariffs', () => {
  it('keeps the current and future periods, oldest first, and drops ended ones', () => {
    const tariffs = tariffsOf(readFriNettleieTariffs({
      tariffer: [
        period('2027-01-01', undefined, 30),
        period('2025-01-01', '2026-07-01', 10),
        period('2026-07-01', '2027-01-01', 20),
      ],
    }, '2026-11-02'));
    expect(tariffs?.Husholdning?.map(({ from, until, basePrice }) => ({ from, until, basePrice }))).toEqual([
      { from: '2026-07-01', until: '2027-01-01', basePrice: 20 },
      { from: '2027-01-01', until: undefined, basePrice: 30 },
    ]);
    expect(tariffs?.['Hytter og fritidshus']).toBeUndefined();
  });

  it('reads exception hours, months and day types', () => {
    const tariffs = tariffsOf(readFriNettleieTariffs({
      tariffer: [period('2026-01-01', undefined, 10, {
        unntak: [
          { navn: 'Dag', timer: ['6-8', 17], dager: ['Virkedag'], måneder: ['januar', 'februar'], pris: 20 },
          { navn: 'Hele døgnet', pris: 5 },
          { navn: 'Natt', timer: '22-5', pris: 3 },
        ],
      })],
    }, '2026-11-02'));
    expect(tariffs?.Husholdning?.[0]?.exceptions).toEqual([
      { hours: [6, 7, 8, 17], price: 20, months: [1, 2], dayTypes: ['virkedag'] },
      { hours: Array.from({ length: 24 }, (_, hour) => hour), price: 5 },
      // A span past midnight.
      { hours: [0, 1, 2, 3, 4, 5, 22, 23], price: 3 },
    ]);
  });

  it('reads a file as malformed when a current period has a field it cannot read', () => {
    const withException = (unntak: Record<string, unknown>) => readFriNettleieTariffs({
      tariffer: [period('2026-01-01', undefined, 10, { unntak: [{ navn: 'Dag', timer: '6-21', pris: 20, ...unntak }] })],
    }, '2026-11-02').kind;
    expect(withException({ timer: '20-99999999' })).toBe('malformed');
    expect(withException({ timer: 'kveld' })).toBe('malformed');
    expect(withException({ måneder: ['januar', 'jnauar'] })).toBe('malformed');
    expect(withException({ dager: ['virkedag', 'hverdag'] })).toBe('malformed');
    expect(withException({ pris: 'tjue' })).toBe('malformed');
    expect(withException({ pris: [20] })).toBe('malformed');
    expect(readFriNettleieTariffs({ tariffer: [period('2026-01-01', 'snart', 10)] }, '2026-11-02').kind).toBe('malformed');
    expect(readFriNettleieTariffs({ tariffer: [period('2026-01-01', undefined, [] as unknown as number)] }, '2026-11-02').kind)
      .toBe('malformed');
  });

  it('ignores a malformed period that has ended', () => {
    const tariffs = tariffsOf(readFriNettleieTariffs({
      tariffer: [
        period('2025-01-01', '2026-01-01', 10, { unntak: [{ navn: 'Dag', timer: 'kveld', pris: 20 }] }),
        period('2026-01-01', undefined, 12),
      ],
    }, '2026-11-02'));
    expect(tariffs?.Husholdning?.map((entry) => entry.basePrice)).toEqual([12]);
  });

  it('reads a period with an implausible fee as malformed', () => {
    expect(readFriNettleieTariffs({ tariffer: [period('2026-01-01', undefined, 9000)] }, '2026-11-02').kind).toBe('malformed');
    expect(readFriNettleieTariffs({
      tariffer: [period('2026-01-01', undefined, 10, { unntak: [{ navn: 'Dag', timer: '6-21', pris: -500 }] })],
    }, '2026-11-02').kind).toBe('malformed');
  });

  it('tells a file with no current period from one that is not a tariff file', () => {
    expect(readFriNettleieTariffs({ tariffer: [period('2025-01-01', '2026-01-01', 10)] }, '2026-11-02').kind).toBe('none');
    expect(readFriNettleieTariffs(null, '2026-11-02').kind).toBe('malformed');
    expect(readFriNettleieTariffs({
      tariffer: [{ kundegrupper: ['husholdning'], energiledd: { grunnpris: 1 } }],
    }, '2026-11-02').kind).toBe('malformed');
  });
});
