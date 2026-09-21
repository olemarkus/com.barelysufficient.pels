import { parseHubMarketRead } from '../src/ui/hubMarket.ts';

describe('hub market read, at the WebView seam', () => {
  it('accepts a resolved ISO country from the runtime', () => {
    expect(parseHubMarketRead({ state: 'resolved', country: 'BE' })).toEqual({ state: 'resolved', country: 'BE' });
  });

  it.each([
    ['unavailable', { state: 'unavailable' }],
    ['a missing payload', undefined],
    ['a resolved state with no country', { state: 'resolved' }],
    ['a lower-case or long code', { state: 'resolved', country: 'bel' }],
    ['a country with no state', { country: 'BE' }],
  ])('draws the market-neutral copy for %s', (_label, value) => {
    expect(parseHubMarketRead(value)).toEqual({ state: 'unavailable' });
  });
});
