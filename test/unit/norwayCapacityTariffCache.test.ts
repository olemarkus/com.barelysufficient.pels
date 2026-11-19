import { readSchemeCapacityTariff } from '../../lib/price/priceServiceNorway';
import type { NorwaySchemeSettings } from '../../lib/price/priceServiceNorway';
import type { PriceDataStore } from '../../lib/price/priceDataStore';
import { partialDouble } from '../helpers/partialDouble';

const text = `tariffer:
  - kundegrupper: [husholdning]
    gyldig_fra: '2026-01-01'
    fastledd:
      metode: TRE_DØGNMAX_MND
      terskel_inkludert: true
      terskler:
        - terskel: 0
        - terskel: 5
        - terskel: 10
`;
const settings: NorwaySchemeSettings = {
  organizationNumber: '824368082', tariffGroup: 'Husholdning', priceArea: 'NO1',
  countyCode: '03', norwayPriceModel: 'stromstotte',
};

describe('capacity tariff source cache', () => {
  it('reuses one result until source, selection, or month changes', () => {
    let source = { organizationNumber: settings.organizationNumber, file: 'vang.yml', text, fetchedAt: '2026-11-01' };
    const store = partialDouble<PriceDataStore>({ readFriNettleieFile: () => source });
    const first = readSchemeCapacityTariff('norway', settings, store, '2026-11');
    expect(first.state).toBe('supported');
    expect(readSchemeCapacityTariff('norway', settings, store, '2026-11')).toBe(first);
    source = { ...source, text: `${text}\n` };
    const changed = readSchemeCapacityTariff('norway', settings, store, '2026-11');
    expect(changed.state).toBe('supported');
    expect(changed).not.toBe(first);
    expect(readSchemeCapacityTariff('norway', settings, store, '2026-12')).not.toBe(changed);
    expect(readSchemeCapacityTariff('norway', { ...settings, tariffGroup: 'Hytter og fritidshus' }, store, '2026-12')
      .state).toBe('unsupported');
    expect(readSchemeCapacityTariff('norway', { ...settings, organizationNumber: 'different' }, store, '2026-12')
      .state).toBe('unavailable');
    expect(readSchemeCapacityTariff('flow', settings, store, '2026-12').state).toBe('unsupported');
  });
});
