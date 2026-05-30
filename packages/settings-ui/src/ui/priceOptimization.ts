import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { setSetting } from './homey.ts';
import { state } from './state.ts';
import { updatePriceConfigDevices } from './priceConfig.ts';

// Re-exported for `priceOpt.ts`; the underlying helper lives in `state.ts`
// to avoid a circular import between this module and `priceConfig.ts`.


export const savePriceOptimizationSettings = async () => {
  await setSetting('price_optimization_settings', state.priceOptimizationSettings);
};

export const renderPriceOptimization = (devices: TargetDeviceSnapshot[]) => {
  updatePriceConfigDevices(devices);
};
