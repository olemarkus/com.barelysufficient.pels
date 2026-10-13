import {
  callApi,
  getSetting,
  invalidateApiCache,
  primeApiCache,
  setSetting,
} from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import {
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import type { NorwayPriceModel, PriceConfigState } from './priceConfigTypes.ts';
import { isPriceArea, saveNorwayPriceModel, savePriceArea } from './priceSettingsPersistence.ts';
import {
  loadPriceSetupSuggestion,
  priceSetupNeedsSuggestion,
  type PriceSetupOffer,
} from './priceSetupOffer.ts';

export type NorwayPriceHandlersContext = {
  getState: () => PriceConfigState;
  patchState: (patch: Partial<PriceConfigState>) => void;
  rerender: () => void;
  /**
   * Re-read the prices payload, which says which settings the owner has chosen,
   * and repaint. A write here is what turns "Not chosen yet" into a choice.
   */
  refreshStatus: () => Promise<void>;
};

const refreshGridTariff = async (): Promise<void> => {
  const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
  primeApiCache(SETTINGS_UI_PRICES_PATH, response ?? null);
};

/**
 * The Norway section's handlers. Each writes its own key, even when the value
 * equals the default PELS was already pricing with: that write is the owner
 * choosing it.
 */
export const createNorwayPriceHandlers = (ctx: NorwayPriceHandlersContext) => {
  const saveChoice = async (save: () => Promise<void>, label: string): Promise<void> => {
    try {
      await save();
      invalidateApiCache(SETTINGS_UI_PRICES_PATH);
      await ctx.refreshStatus();
      await showToast('Price settings saved.', 'ok');
    } catch (error) {
      await logSettingsError(`Failed to save ${label}`, error, 'priceConfig');
      await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
    }
  };

  const onNorwayModelChange = async (model: NorwayPriceModel): Promise<void> => {
    ctx.patchState({ norwayPriceModel: model });
    await saveChoice(() => saveNorwayPriceModel(model), 'Norway price model');
  };

  const onPriceAreaChange = async (area: string): Promise<void> => {
    if (!isPriceArea(area)) return;
    ctx.patchState({ priceArea: area });
    await saveChoice(() => savePriceArea(area), 'price area');
  };

  // A grid company belongs to its county, so a new county clears it: left
  // stored, the old company's tariff would stay in every price.
  const onCountyChange = async (code: string): Promise<void> => {
    const hadGridCompany = ctx.getState().organizationNumber !== '';
    ctx.patchState({ countyCode: code, organizationNumber: '' });
    ctx.rerender();
    try {
      await setSetting('nettleie_fylke', code);
      await setSetting('nettleie_orgnr', '');
      await refreshGridTariff();
      await ctx.refreshStatus();
      const toast = hadGridCompany ? 'County saved. Choose your grid company again.' : 'Grid tariff settings saved.';
      await showToast(toast, 'ok');
    } catch (error) {
      await logSettingsError('Failed to save county', error, 'priceConfig');
      await showToastError(error, 'Failed to save grid tariff settings.');
    }
  };

  const onOrganizationChange = async (orgNumber: string): Promise<void> => {
    ctx.patchState({ organizationNumber: orgNumber });
    try {
      const [currentCounty, currentOrg, currentGroup] = await Promise.all([
        getSetting('nettleie_fylke'),
        getSetting('nettleie_orgnr'),
        getSetting('nettleie_tariffgruppe'),
      ]);
      const { countyCode, tariffGroup } = ctx.getState();
      const writes: Array<Promise<void>> = [];
      pushSettingWriteIfChanged(writes, 'nettleie_fylke', currentCounty, countyCode);
      pushSettingWriteIfChanged(writes, 'nettleie_orgnr', currentOrg, orgNumber);
      pushSettingWriteIfChanged(writes, 'nettleie_tariffgruppe', currentGroup, tariffGroup);
      if (writes.length > 0) {
        await Promise.all(writes);
        await refreshGridTariff();
      }
      await ctx.refreshStatus();
      await showToast('Grid tariff settings saved.', 'ok');
    } catch (error) {
      await logSettingsError('Failed to save organization', error, 'priceConfig');
      await showToastError(error, 'Failed to save grid tariff settings.');
    }
  };

  const onTariffGroupChange = async (group: string): Promise<void> => {
    ctx.patchState({ tariffGroup: group });
    try {
      await setSetting('nettleie_tariffgruppe', group);
      await showToast('Grid tariff settings saved.', 'ok');
    } catch (error) {
      await logSettingsError('Failed to save tariff group', error, 'priceConfig');
      await showToastError(error, 'Failed to save grid tariff settings.');
    }
  };

  // Asked once per visit to the settings: the lookup sends the hub's
  // coordinates to NVE and Kartverket, so it runs only when the owner opens the
  // page and something is still missing, and never again after an answer.
  let suggestionRequested = false;
  const suggestFromLocation = async (): Promise<void> => {
    const { priceSetup } = ctx.getState();
    if (suggestionRequested || !priceSetupNeedsSuggestion(priceSetup)) return;
    suggestionRequested = true;
    ctx.patchState({ priceSetupSuggestion: await loadPriceSetupSuggestion() });
    ctx.rerender();
  };

  // One confirmation writes everything offered. The county goes with the grid
  // company because the company belongs to it, unless the owner chose it.
  // Every write starts on the tap, so a field the owner changes while they are
  // in flight is written after them and stays.
  const onUseOffer = async (offer: PriceSetupOffer): Promise<void> => {
    if (offer.kind === 'none') return;
    const writes: Array<Promise<void>> = [];
    if (offer.kind !== 'price_area') {
      const { county, organizationNumber } = offer.gridCompany;
      if (county.kind === 'set') {
        ctx.patchState({ countyCode: county.code });
        writes.push(setSetting('nettleie_fylke', county.code));
      }
      ctx.patchState({ organizationNumber });
      writes.push(setSetting('nettleie_orgnr', organizationNumber));
    }
    if (offer.kind !== 'grid_company') {
      ctx.patchState({ priceArea: offer.priceArea });
      writes.push(savePriceArea(offer.priceArea));
    }
    ctx.rerender();
    try {
      await Promise.all(writes);
      if (offer.kind !== 'price_area') await refreshGridTariff();
      invalidateApiCache(SETTINGS_UI_PRICES_PATH);
      await ctx.refreshStatus();
      await showToast('Price settings saved.', 'ok');
    } catch (error) {
      await logSettingsError('Failed to save the suggested price settings', error, 'priceConfig');
      await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
    }
  };

  return {
    onNorwayModelChange,
    onPriceAreaChange,
    onCountyChange,
    onOrganizationChange,
    onTariffGroupChange,
    suggestFromLocation,
    onUseOffer,
  };
};
