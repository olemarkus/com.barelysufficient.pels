import { readNorwayCapacityTariff, readSavedNorwayCapacityTariff } from '../../lib/price/norwayCapacityTariff';
import { readFriNettleieTariffs } from '../../lib/price/friNettleieTariff';

const period = (extra: Record<string, unknown> = {}) => ({
  kundegrupper: ['husholdning'],
  gyldig_fra: '2026-01-01',
  energiledd: { grunnpris: 12 },
  fastledd: {
    metode: 'TRE_DØGNMAX_MND',
    terskel_inkludert: true,
    terskler: [0, 2, 5, 10].map((terskel) => ({ terskel, pris: 100 })),
  },
  ...extra,
});
const read = (tariffer: unknown[]) => readNorwayCapacityTariff({ tariffer }, '123', 'Husholdning', '2026-11');

describe('Norway capacity tariff facts', () => {
  it('reads sorted lower boundaries independently of energy prices', () => {
    const result = read([period({ energiledd: null })]);
    expect(result).toMatchObject({ state: 'supported', tariff: { boundariesKw: [0, 2, 5, 10], thresholdIncluded: true } });
  });

  it('keeps exact equality rules in the semantic tariff', () => {
    const source = period();
    source.fastledd.terskel_inkludert = false;
    expect(read([source])).toMatchObject({ state: 'supported', tariff: { thresholdIncluded: false } });
  });

  it('does not invalidate energy prices when the capacity method is unsupported', () => {
    const source = period({ fastledd: { metode: 'MND_MAX' } });
    expect(read([source])).toEqual({ state: 'unsupported', reason: 'unsupported_capacity_method' });
    expect(readFriNettleieTariffs({ tariffer: [source] }, '2026-11-01').kind).toBe('tariffs');
  });

  it('requires one tariff covering the entire month, with exclusive end dates', () => {
    expect(read([period({ gyldig_til: '2026-12-01' })]).state).toBe('supported');
    expect(read([period({ gyldig_til: '2026-11-15' }), period({ gyldig_fra: '2026-11-15' })]).state)
      .toBe('unsupported');
    expect(read([period({ gyldig_fra: '2026-11-02' })]).state).toBe('unsupported');
    expect(read([period(), period()]).state).toBe('unsupported');
  });

  it('does not use another customer group', () => {
    expect(read([period({ kundegrupper: ['fritid'] })]).state).toBe('unsupported');
    expect(readNorwayCapacityTariff({ tariffer: [period({ kundegrupper: ['fritid'] })] },
      '123', 'Hytter og fritidshus', '2026-11').state).toBe('supported');
  });

  it.each([null, 'true', undefined])('rejects an ambiguous equality rule %s', (terskel_inkludert) => {
    expect(read([period({ fastledd: { ...period().fastledd, terskel_inkludert } })]).state).toBe('unsupported');
  });

  it.each([[0, 5, 5], [2, 5, 10], [0, -1, 5], [0, NaN, 10], [0, Infinity], [0]])(
    'rejects malformed boundaries %s', (...boundaries) => {
      expect(read([period({ fastledd: {
        ...period().fastledd, terskler: boundaries.map((terskel) => ({ terskel })),
      } })]).state).toBe('unavailable');
    },
  );


  it('accepts date-time dates and ignores visibly ended malformed old periods', () => {
    const current = period({ gyldig_fra: '2026-01-01T00:00:00', gyldig_til: '2026-12-01T00:00:00' });
    expect(read([period({ gyldig_fra: 'unreadable', gyldig_til: '2026-01-01', fastledd: null }), current]).state)
      .toBe('supported');
  });

  it('rejects an invalid calendar date and invalid billing month', () => {
    expect(read([period({ gyldig_fra: '2026-02-31' })]).state).toBe('unavailable');
    expect(readNorwayCapacityTariff({ tariffer: [period()] }, '123', 'Husholdning', '2026-13').state)
      .toBe('unavailable');
  });

  it('changes identity for company, group, bounds, and equality rule', () => {
    const a = read([period()]);
    const b = read([period({ fastledd: { ...period().fastledd, terskel_inkludert: false } })]);
    if (a.state !== 'supported' || b.state !== 'supported') throw new Error('Expected supported tariffs');
    expect(a.tariff.identity).not.toBe(b.tariff.identity);
    const c = readNorwayCapacityTariff({ tariffer: [period()] }, '456', 'Husholdning', '2026-11');
    if (c.state !== 'supported') throw new Error('Expected supported tariff');
    expect(a.tariff.identity).not.toBe(c.tariff.identity);
  });

  it('never reuses a saved file from a different operator or filename', () => {
    const saved = { organizationNumber: '123', file: 'other.yml', text: '', fetchedAt: '2026-11-01' };
    expect(readSavedNorwayCapacityTariff(saved, '456', 'Husholdning', '2026-11').state).toBe('unavailable');
    expect(readSavedNorwayCapacityTariff(saved, '123', 'Husholdning', '2026-11').state).toBe('unavailable');
  });
});
