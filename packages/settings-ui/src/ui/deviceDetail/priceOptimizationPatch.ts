import { logSettingsError } from '../logging.ts';
import { savePriceOptimizationSettings } from '../priceOptimization.ts';
import { state, type PriceOptimizationConfig } from '../state.ts';
import { showToastError } from '../toast.ts';

// A fresh entry for a device that only opts into solar surplus (a binary dump
// load or a stepped load): price-response off and zero deltas, NOT the
// temperature defaults — such a device has no setpoint to shift.
export const SURPLUS_ONLY_PRICE_OPTIMIZATION_CONFIG: PriceOptimizationConfig = {
  enabled: false,
  cheapDelta: 0,
  expensiveDelta: 0,
  priceConfigured: false,
  surplusWilling: false,
  surplusDelta: 0,
};

/**
 * Optimistic save of one device's price-optimization fields from its detail
 * panel. Applies `patch` to the device's entry (a device with none starts from
 * `fresh`) and persists the map. When the Homey write fails, the patched fields
 * roll back to their values before the save, but only if no newer edit replaced
 * them while the save was in flight. Only the patched fields are restored, never
 * the whole entry or map, so a late failure never clobbers an overlapping edit
 * to other fields; an entry this save created is removed only when nothing else
 * changed it. `onRolledBack` then re-binds the panel before the failure is
 * logged and toasted. Resolves whether the save landed.
 */
export const savePriceOptimizationPatch = async (
  deviceId: string,
  patch: Partial<PriceOptimizationConfig>,
  fresh: PriceOptimizationConfig,
  failureMessage: string,
  onRolledBack: () => void,
): Promise<boolean> => {
  const previous = state.priceOptimizationSettings[deviceId];
  const patchedKeys = Object.keys(patch) as (keyof PriceOptimizationConfig)[];
  state.priceOptimizationSettings[deviceId] = { ...(previous ?? fresh), ...patch };
  try {
    await savePriceOptimizationSettings();
    return true;
  } catch (error) {
    const current = state.priceOptimizationSettings[deviceId];
    if (current && patchedKeys.every((key) => current[key] === patch[key])) {
      const before = previous ?? fresh;
      const restored: PriceOptimizationConfig = {
        ...current,
        ...Object.fromEntries(patchedKeys.map((key) => [key, before[key]])),
      };
      const untouchedFreshEntry = previous === undefined
        && (Object.keys(fresh) as (keyof PriceOptimizationConfig)[]).every((key) => restored[key] === fresh[key]);
      if (untouchedFreshEntry) delete state.priceOptimizationSettings[deviceId];
      else state.priceOptimizationSettings[deviceId] = restored;
    }
    onRolledBack();
    await logSettingsError(failureMessage, error, 'device detail');
    await showToastError(error, `${failureMessage}.`);
    return false;
  }
};
