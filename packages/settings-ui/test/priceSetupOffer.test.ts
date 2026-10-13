import { describe, expect, it } from 'vitest';
import {
  parsePriceSetupSuggestion,
  priceSetupNeedsSuggestion,
  resolvePriceSetupOffer,
} from '../src/ui/priceSetupOffer.ts';
import type {
  NorwayPriceSetup,
  PriceSetupRead,
  PriceSetupSuggestion,
} from '../../contracts/src/settingsUiApi.ts';

const NOTHING_CHOSEN: NorwayPriceSetup = {
  county: { value: '03', chosen: false },
  gridCompany: { kind: 'none' },
  tariffGroup: { value: 'Husholdning', chosen: false },
  pricingModel: { value: 'stromstotte', chosen: false },
  priceArea: { value: 'NO1', chosen: false },
};

const norwayRead = (norway: Partial<NorwayPriceSetup> = {}, scheme: 'norway' | 'homey' = 'norway'): PriceSetupRead => ({
  state: 'resolved',
  setup: { source: { scheme, basis: { kind: 'chosen' } }, norway: { ...NOTHING_CHOSEN, ...norway } },
});

const TENSIO_NO3: PriceSetupSuggestion = {
  gridCompany: { kind: 'found', organizationNumber: '978631029', name: 'TENSIO TS AS', countyCode: '50' },
  priceArea: { kind: 'from_homey_energy', area: 'NO3' },
  powerhour: { kind: 'none' },
};
const NOTHING: PriceSetupSuggestion = {
  gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'none' },
};

describe('parsePriceSetupSuggestion', () => {
  it('accepts a whole suggestion', () => {
    expect(parsePriceSetupSuggestion(TENSIO_NO3)).toEqual(TENSIO_NO3);
  });

  it('reads whether Power by the Hour has a price device', () => {
    expect(parsePriceSetupSuggestion({ ...NOTHING, powerhour: { kind: 'has_price_device' } }).powerhour)
      .toEqual({ kind: 'has_price_device' });
    expect(parsePriceSetupSuggestion({ ...NOTHING, powerhour: 'yes' }).powerhour).toEqual({ kind: 'none' });
  });

  it('drops a malformed part on its own, and anything else is no suggestion', () => {
    expect(parsePriceSetupSuggestion({ ...TENSIO_NO3, priceArea: { kind: 'from_homey_energy', area: 'SE3' } }))
      .toEqual({ ...TENSIO_NO3, priceArea: { kind: 'none' } });
    expect(parsePriceSetupSuggestion({ ...TENSIO_NO3, gridCompany: { ...TENSIO_NO3.gridCompany, countyCode: 50 } }))
      .toEqual({ ...TENSIO_NO3, gridCompany: { kind: 'none' } });
    expect(parsePriceSetupSuggestion(null)).toEqual(NOTHING);
  });
});

describe('priceSetupNeedsSuggestion', () => {
  it('asks on Norway while the grid company or price area is missing, and on Homey Energy without prices', () => {
    expect(priceSetupNeedsSuggestion(norwayRead(), true)).toBe(true);
    expect(priceSetupNeedsSuggestion(norwayRead({
      gridCompany: { kind: 'chosen', organizationNumber: '978631029' },
    }), true)).toBe(true);
    expect(priceSetupNeedsSuggestion(norwayRead({
      gridCompany: { kind: 'chosen', organizationNumber: '978631029' },
      priceArea: { value: 'NO3', chosen: true },
    }), true)).toBe(false);
    expect(priceSetupNeedsSuggestion(norwayRead({}, 'homey'), true)).toBe(false);
    // Homey Energy without prices: Power by the Hour may have them.
    expect(priceSetupNeedsSuggestion(norwayRead({}, 'homey'), false)).toBe(true);
    expect(priceSetupNeedsSuggestion({ state: 'unavailable' }, true)).toBe(false);
  });
});

describe('resolvePriceSetupOffer', () => {
  const TENSIO_OFFERED = { organizationNumber: '978631029', name: 'TENSIO TS AS', county: { kind: 'set', code: '50' } };

  it('offers the grid company with its county, and the price area the owner has not chosen', () => {
    expect(resolvePriceSetupOffer(TENSIO_NO3, norwayRead())).toEqual({
      kind: 'grid_company_and_area',
      gridCompany: TENSIO_OFFERED,
      priceArea: 'NO3',
    });
  });

  it('never offers over a choice the owner made', () => {
    expect(resolvePriceSetupOffer(TENSIO_NO3, norwayRead({ priceArea: { value: 'NO4', chosen: true } })))
      .toEqual({ kind: 'grid_company', gridCompany: TENSIO_OFFERED });
    expect(resolvePriceSetupOffer(TENSIO_NO3, norwayRead({
      gridCompany: { kind: 'chosen', organizationNumber: '980489698' },
    }))).toEqual({ kind: 'price_area', priceArea: 'NO3' });
    expect(resolvePriceSetupOffer(TENSIO_NO3, norwayRead({
      gridCompany: { kind: 'chosen', organizationNumber: '980489698' },
      priceArea: { value: 'NO4', chosen: true },
    }))).toEqual({ kind: 'none' });
  });

  it('keeps a county the owner chose, and offers no company found in another one', () => {
    expect(resolvePriceSetupOffer(TENSIO_NO3, norwayRead({ county: { value: '50', chosen: true } })))
      .toMatchObject({ gridCompany: { ...TENSIO_OFFERED, county: { kind: 'kept' } } });
    expect(resolvePriceSetupOffer(TENSIO_NO3, norwayRead({ county: { value: '03', chosen: true } })))
      .toEqual({ kind: 'price_area', priceArea: 'NO3' });
  });

  it('offers no grid company PELS does not list in that county, since the field could not show it', () => {
    const unlisted: PriceSetupSuggestion = {
      ...TENSIO_NO3,
      gridCompany: { kind: 'found', organizationNumber: '999999999', name: 'NEW AS', countyCode: '50' },
    };
    expect(resolvePriceSetupOffer(unlisted, norwayRead())).toEqual({ kind: 'price_area', priceArea: 'NO3' });
    // TENSIO TS is listed for Innlandet and Trøndelag, not Oslo.
    const elsewhere: PriceSetupSuggestion = {
      gridCompany: { ...TENSIO_NO3.gridCompany, countyCode: '03' } as PriceSetupSuggestion['gridCompany'],
      priceArea: { kind: 'none' },
      powerhour: { kind: 'none' },
    };
    expect(resolvePriceSetupOffer(elsewhere, norwayRead())).toEqual({ kind: 'none' });
  });

  it('offers nothing without a suggestion or the read', () => {
    expect(resolvePriceSetupOffer(NOTHING, norwayRead())).toEqual({ kind: 'none' });
    expect(resolvePriceSetupOffer(TENSIO_NO3, { state: 'unavailable' })).toEqual({ kind: 'none' });
  });
});
