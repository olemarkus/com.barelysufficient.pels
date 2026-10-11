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
import { SETTINGS_UI_REFRESH_GRID_TARIFF_PATH } from '../../contracts/src/settingsUiApi.ts';

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
});
