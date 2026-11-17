import { PRICE_OPTIMIZATION_ENABLED } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { SETTINGS_UI_PRICES_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { invalidateApiCache, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { refreshAfterSetupRecommendations } from './recommendations.ts';
import { showToast, showToastError } from './toast.ts';

/** Confirmation and persistence for the global Respond to prices switch. */
export const createPriceOptimizationToggle = (
  getEnabled: () => boolean,
  applySaved: (enabled: boolean) => void,
  render: () => void,
) => {
  let busy = false;
  let offArmed = false;

  const save = async (enabled: boolean) => {
    if (busy) return;
    busy = true;
    render();
    try {
      await setSetting(PRICE_OPTIMIZATION_ENABLED, enabled);
      applySaved(enabled);
    } catch (error) {
      await logSettingsError('Failed to update price optimization', error, 'priceConfig');
      await showToastError(error, 'Failed to update Respond to prices.');
      return;
    } finally {
      busy = false;
      render();
    }
    invalidateApiCache(SETTINGS_UI_PRICES_PATH);
    try {
      await refreshAfterSetupRecommendations();
    } catch (error) {
      // The setting is already saved. A failed follow-up read cannot undo it.
      await logSettingsError('Failed to refresh recommendations after price setting update', error, 'priceConfig');
    }
    await showToast(enabled ? 'Respond to prices turned on.' : 'Respond to prices turned off.', 'ok');
  };

  return {
    get busy() { return busy; },
    get offArmed() { return offArmed; },
    toggle: async (enabled: boolean) => {
      if (busy || offArmed || enabled === getEnabled()) return;
      if (!enabled) {
        offArmed = true;
        render();
        return;
      }
      await save(true);
    },
    dismissOff: () => {
      if (!offArmed) return;
      offArmed = false;
      render();
    },
    confirmOff: async () => {
      if (!offArmed || busy) return;
      offArmed = false;
      await save(false);
    },
  };
};
