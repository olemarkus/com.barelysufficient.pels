import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const homeyMocks = vi.hoisted(() => ({
  callApi: vi.fn(),
  getSetting: vi.fn(),
  invalidateApiCache: vi.fn(),
  primeApiCache: vi.fn(),
  setSetting: vi.fn(),
}));
vi.mock('../src/ui/homey.ts', () => homeyMocks);
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn(), showToastError: vi.fn() }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn() }));

import { createNorwayPriceHandlers } from '../src/ui/norwayPriceHandlers.ts';
import type { PriceConfigState } from '../src/ui/priceConfigTypes.ts';
import {
  SETTINGS_UI_PRICE_SETUP_SUGGESTION_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  type NorwayPriceSetup,
  type PriceSetupRead,
} from '../../contracts/src/settingsUiApi.ts';

const setSettingMock = homeyMocks.setSetting as Mock;

const createHandlers = (initial: Partial<PriceConfigState>) => {
  let state = initial as PriceConfigState;
  const refreshStatus = vi.fn(async () => undefined);
  const handlers = createNorwayPriceHandlers({
    getState: () => state,
    patchState: (patch) => { state = { ...state, ...patch }; },
    rerender: vi.fn(),
    refreshStatus,
  });
  return { handlers, refreshStatus, getState: () => state };
};

beforeEach(() => {
  vi.clearAllMocks();
  setSettingMock.mockResolvedValue(undefined);
  (homeyMocks.callApi as Mock).mockResolvedValue(null);
});

describe('Norway price handlers', () => {
  it('clears the grid company with a new county, so its tariff leaves the prices', async () => {
    const { handlers, refreshStatus, getState } = createHandlers({ countyCode: '03', organizationNumber: '980489698' });

    await handlers.onCountyChange('55');

    expect(setSettingMock.mock.calls).toEqual([['nettleie_fylke', '55'], ['nettleie_orgnr', '']]);
    expect(homeyMocks.callApi).toHaveBeenCalledWith('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
    expect(getState()).toEqual(expect.objectContaining({ countyCode: '55', organizationNumber: '' }));
    expect(refreshStatus).toHaveBeenCalled();
  });

  it('saves the price area the owner picks, even when PELS was already pricing with it', async () => {
    // Picking NO1 is what makes NO1 the owner's choice rather than PELS's default.
    const { handlers, refreshStatus } = createHandlers({ priceArea: 'NO1' });

    await handlers.onPriceAreaChange('NO1');

    expect(setSettingMock).toHaveBeenCalledWith('price_area', 'NO1');
    expect(homeyMocks.invalidateApiCache).toHaveBeenCalled();
    expect(refreshStatus).toHaveBeenCalled();
  });

  it('saves the pricing model the owner picks, even when it is the default', async () => {
    const { handlers } = createHandlers({ norwayPriceModel: 'stromstotte' });

    await handlers.onNorwayModelChange('stromstotte');

    expect(setSettingMock).toHaveBeenCalledWith('norway_price_model', 'stromstotte');
  });

  it('ignores a price area that is not one', async () => {
    const { handlers } = createHandlers({ priceArea: 'NO1' });

    await handlers.onPriceAreaChange('SE3');

    expect(setSettingMock).not.toHaveBeenCalled();
  });

  describe('the suggestion from the hub\'s location', () => {
    const TENSIO = { organizationNumber: '978631029', name: 'TENSIO TS AS', county: { kind: 'set', code: '50' } } as const;

    const norwaySetup = (norway: Partial<NorwayPriceSetup>): PriceSetupRead => ({
      state: 'resolved',
      setup: {
        source: { scheme: 'norway', basis: { kind: 'chosen' } },
        norway: {
          county: { value: '03', chosen: false },
          gridCompany: { kind: 'none' },
          tariffGroup: { value: 'Husholdning', chosen: false },
          pricingModel: { value: 'stromstotte', chosen: false },
          priceArea: { value: 'NO1', chosen: false },
          ...norway,
        },
      },
    });

    it('writes the grid company with its county and the price area, in one confirmation', async () => {
      const { handlers, refreshStatus, getState } = createHandlers({ countyCode: '03', organizationNumber: '' });

      await handlers.onUseOffer({ kind: 'grid_company_and_area', gridCompany: TENSIO, priceArea: 'NO3' });

      expect(setSettingMock.mock.calls).toEqual([
        ['nettleie_fylke', '50'],
        ['nettleie_orgnr', '978631029'],
        ['price_area', 'NO3'],
      ]);
      expect(homeyMocks.callApi).toHaveBeenCalledWith('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
      expect(getState()).toEqual(expect.objectContaining({
        countyCode: '50', organizationNumber: '978631029', priceArea: 'NO3',
      }));
      expect(refreshStatus).toHaveBeenCalled();
    });

    it('keeps a county the owner chose', async () => {
      const { handlers } = createHandlers({ countyCode: '50', organizationNumber: '' });

      await handlers.onUseOffer({ kind: 'grid_company', gridCompany: { ...TENSIO, county: { kind: 'kept' } } });

      expect(setSettingMock.mock.calls).toEqual([['nettleie_orgnr', '978631029']]);
    });

    it('writes only the price area when that is all it offers', async () => {
      const { handlers } = createHandlers({ priceArea: 'NO1' });

      await handlers.onUseOffer({ kind: 'price_area', priceArea: 'NO4' });

      expect(setSettingMock.mock.calls).toEqual([['price_area', 'NO4']]);
      expect(homeyMocks.callApi).not.toHaveBeenCalled();
    });

    it('asks once, and only while a grid company or price area is missing', async () => {
      (homeyMocks.callApi as Mock).mockResolvedValue({
        gridCompany: { kind: 'found', organizationNumber: '978631029', name: 'TENSIO TS AS', countyCode: '50' },
        priceArea: { kind: 'from_homey_energy', area: 'NO3' },
      });
      const { handlers, getState } = createHandlers({ priceSetup: norwaySetup({}) });

      await handlers.suggestFromLocation();
      await handlers.suggestFromLocation();

      expect(homeyMocks.callApi).toHaveBeenCalledTimes(1);
      expect(homeyMocks.callApi).toHaveBeenCalledWith('GET', SETTINGS_UI_PRICE_SETUP_SUGGESTION_PATH);
      expect(getState().priceSetupSuggestion).toMatchObject({ gridCompany: { kind: 'found', countyCode: '50' } });
    });

    it('asks on Homey Energy without prices, and not while Homey Energy has them', async () => {
      const norway = norwaySetup({}) as Extract<PriceSetupRead, { state: 'resolved' }>;
      const homeySetup: PriceSetupRead = {
        state: 'resolved',
        setup: { ...norway.setup, source: { scheme: 'homey', basis: { kind: 'chosen' } } },
      };
      const withPrices = createHandlers({ priceSetup: homeySetup, homeyStatus: { hasPrices: true } as PriceConfigState['homeyStatus'] });
      await withPrices.handlers.suggestFromLocation();
      expect(homeyMocks.callApi).not.toHaveBeenCalled();

      const without = createHandlers({ priceSetup: homeySetup, homeyStatus: { hasPrices: false } as PriceConfigState['homeyStatus'] });
      await without.handlers.suggestFromLocation();
      expect(homeyMocks.callApi).toHaveBeenCalledWith('GET', SETTINGS_UI_PRICE_SETUP_SUGGESTION_PATH);
    });

    it('asks again for a source the owner switches to in the same visit', async () => {
      (homeyMocks.callApi as Mock).mockResolvedValue(null);
      const norway = norwaySetup({}) as Extract<PriceSetupRead, { state: 'resolved' }>;
      let state = {
        priceScheme: 'homey',
        priceSetup: { state: 'resolved', setup: { ...norway.setup, source: { scheme: 'homey', basis: { kind: 'chosen' } } } },
        homeyStatus: { hasPrices: false },
      } as unknown as PriceConfigState;
      const handlers = createNorwayPriceHandlers({
        getState: () => state,
        patchState: (patch) => { state = { ...state, ...patch }; },
        rerender: vi.fn(),
        refreshStatus: vi.fn(async () => undefined),
      });

      await handlers.suggestFromLocation();
      // The owner follows "choose another source" and picks Norway.
      state = { ...state, priceScheme: 'norway', priceSetup: norway };
      await handlers.suggestFromLocation();
      await handlers.suggestFromLocation();

      expect(homeyMocks.callApi).toHaveBeenCalledTimes(2);
    });

    it('sends the location nowhere once the owner chose both', async () => {
      const { handlers } = createHandlers({
        priceSetup: norwaySetup({
          gridCompany: { kind: 'chosen', organizationNumber: '978631029' },
          priceArea: { value: 'NO3', chosen: true },
        }),
      });

      await handlers.suggestFromLocation();

      expect(homeyMocks.callApi).not.toHaveBeenCalled();
    });
  });
});
