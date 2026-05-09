import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { getSetting, setSetting } from './homey.ts';
import { defaultPriceOptimizationConfig, state } from './state.ts';
import { updatePriceConfigDevices } from './priceConfig.ts';

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
