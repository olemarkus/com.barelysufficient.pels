import { classifyHubMarket } from '../../lib/home/hubMarket';

describe('hub market', () => {
  it('resolves the system manager\'s country to an upper-case ISO code', () => {
    expect(classifyHubMarket({ country: 'NO', language: 'en', timezone: 'Europe/Oslo' }))
      .toEqual({ state: 'resolved', country: 'NO' });
    expect(classifyHubMarket({ country: ' be ' })).toEqual({ state: 'resolved', country: 'BE' });
  });

  it('never reads a market out of the hub\'s language', () => {
    // A hub in Norway set to English, and one with no country at all: the
    // language is present in both and must decide nothing.
    expect(classifyHubMarket({ language: 'nl' })).toEqual({ state: 'unavailable' });
    expect(classifyHubMarket({ country: 'NO', language: 'nl' })).toEqual({ state: 'resolved', country: 'NO' });
  });

  it.each([
    ['a missing response', undefined],
    ['null', null],
    ['an array', ['NO']],
    ['a non-string country', { country: 47 }],
    ['an empty country', { country: '' }],
    ['a three-letter code', { country: 'NOR' }],
    ['a country name', { country: 'Norway' }],
  ])('resolves %s to unavailable rather than guessing', (_label, raw) => {
    expect(classifyHubMarket(raw)).toEqual({ state: 'unavailable' });
  });
});
