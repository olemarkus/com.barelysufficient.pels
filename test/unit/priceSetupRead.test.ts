import { describe, expect, it } from 'vitest';
import { readPriceSetup } from '../../lib/price/priceSetupRead';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { ResolvedPriceScheme } from '../../packages/contracts/src/settingsUiApi';

const settingsWith = (values: Record<string, unknown>, keys = Object.keys(values)): SettingsPort => ({
  get: (key) => values[key],
  set: () => {},
  unset: () => {},
  getKeys: () => keys,
});

const ASSUMED_NORWAY: ResolvedPriceScheme = { scheme: 'norway', basis: { kind: 'hub_location', country: 'NO' } };

describe('readPriceSetup', () => {
  it('marks every Norway setting PELS is assuming', () => {
    // A fresh install: only unrelated keys, so every price value is a default.
    const read = readPriceSetup(settingsWith({ capacity_limit_kw: 8 }), ASSUMED_NORWAY);

    expect(read).toEqual({
      state: 'resolved',
      setup: {
        source: ASSUMED_NORWAY,
        norway: {
          county: { value: '03', chosen: false },
          gridCompany: { kind: 'none' },
          tariffGroup: { value: 'Husholdning', chosen: false },
          pricingModel: { value: 'stromstotte', chosen: false },
          priceArea: { value: 'NO1', chosen: false },
        },
      },
    });
  });

  it('marks the settings the owner saved as chosen', () => {
    const read = readPriceSetup(settingsWith({
      nettleie_fylke: '55',
      nettleie_orgnr: '979151950',
      nettleie_tariffgruppe: 'Husholdning',
      norway_price_model: 'norgespris',
      price_area: 'NO4',
    }), { scheme: 'norway', basis: { kind: 'chosen' } });

    expect(read).toEqual({
      state: 'resolved',
      setup: {
        source: { scheme: 'norway', basis: { kind: 'chosen' } },
        norway: {
          county: { value: '55', chosen: true },
          gridCompany: { kind: 'chosen', organizationNumber: '979151950' },
          tariffGroup: { value: 'Husholdning', chosen: true },
          pricingModel: { value: 'norgespris', chosen: true },
          priceArea: { value: 'NO4', chosen: true },
        },
      },
    });
  });

  it('does not count a stored value PELS replaces with its default as chosen', () => {
    const read = readPriceSetup(settingsWith({
      nettleie_orgnr: '',
      norway_price_model: 'something else',
      price_area: '',
    }), ASSUMED_NORWAY);

    expect(read.state === 'resolved' && read.setup.norway).toEqual(expect.objectContaining({
      gridCompany: { kind: 'none' },
      pricingModel: { value: 'stromstotte', chosen: false },
      priceArea: { value: 'NO1', chosen: false },
    }));
  });

  it('is unavailable when a saved Norway setting reads back nothing', () => {
    // Listed, so the owner saved it: reporting the default here would tell the
    // settings UI that PELS is assuming a value the owner actually chose.
    expect(readPriceSetup(settingsWith({ price_area: null, nettleie_orgnr: '979151950' }), ASSUMED_NORWAY))
      .toEqual({ state: 'unavailable' });
  });

  it('is unavailable when the key list cannot tell a saved value from a missed read', () => {
    expect(readPriceSetup(settingsWith({ price_area: 'NO4' }, []), ASSUMED_NORWAY))
      .toEqual({ state: 'unavailable' });
  });
});
