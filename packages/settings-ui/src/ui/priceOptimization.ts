import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { getSetting, setSetting } from './homey.ts';
import { defaultPriceOptimizationConfig, state } from './state.ts';
import { updatePriceConfigDevices } from './priceConfig.ts';

// Re-exported for `priceOpt.ts`; the underlying helper lives in `state.ts`
// to avoid a circular import between this module and `priceConfig.ts`.
export { clonePriceOptimizationSettings } from './state.ts';

export const loadPriceOptimizationSettings = async () => {
  const settings = await getSetting('price_optimization_settings');
  if (settings && typeof settings === 'object') {
    state.priceOptimizationSettings = settings as Record<string, typeof defaultPriceOptimizationConfig>;
  }
};

export const savePriceOptimizationSettings = async () => {
  await setSetting('price_optimization_settings', state.priceOptimizationSettings);
};

export const renderPriceOptimization = (devices: TargetDeviceSnapshot[]) => {
  updatePriceConfigDevices(devices);
};
