import type { TargetDeviceSnapshot } from '../../../lib/utils/types';
import { createDeviceRow, createNumberInput } from './components';
import { priceOptimizationEmpty, priceOptimizationList, priceOptimizationSection } from './dom';
import { getSetting, setSetting } from './homey';
import { logSettingsError } from './logging';
import { resolveManagedState, defaultPriceOptimizationConfig, state } from './state';
import { showToastError } from './toast';
import { supportsPowerDevice } from './deviceUtils';

const supportsTemperatureDevice = (device: TargetDeviceSnapshot): boolean => (
  device.deviceType === 'temperature' || (device.targets?.length ?? 0) > 0
);

export const loadPriceOptimizationSettings = async () => {
  const settings = await getSetting('price_optimization_settings');
  if (settings && typeof settings === 'object') {
    state.priceOptimizationSettings = settings as Record<string, typeof defaultPriceOptimizationConfig>;
  }
};

export const savePriceOptimizationSettings = async () => {
  await setSetting('price_optimization_settings', state.priceOptimizationSettings);
};

const getPriceOptimizationConfig = (deviceId: string) => (
  state.priceOptimizationSettings[deviceId] || { ...defaultPriceOptimizationConfig }
);

const ensurePriceOptimizationConfig = (deviceId: string) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { ...defaultPriceOptimizationConfig };
  }
  return state.priceOptimizationSettings[deviceId];
};

const buildPriceOptimizationRow = (device: TargetDeviceSnapshot): HTMLElement => {
  const config = getPriceOptimizationConfig(device.id);

  const cheapInput = createNumberInput({
    value: config.cheapDelta ?? 5,
    min: -20,
    max: 20,
    step: 0.5,
    className: 'price-opt-input',
    title: 'Temperature adjustment during cheap hours (e.g., +5 to boost)',
    onChange: async (val) => {
      const nextConfig = ensurePriceOptimizationConfig(device.id);
      nextConfig.cheapDelta = val;
      try {
        await savePriceOptimizationSettings();
      } catch (error) {
        await logSettingsError('Failed to save cheap price delta', error, 'priceOptimizationRow');
        await showToastError(error, 'Failed to save cheap price delta.');
      }
    },
  });

  const expensiveInput = createNumberInput({
    value: config.expensiveDelta ?? -5,
    min: -20,
    max: 20,
    step: 0.5,
    className: 'price-opt-input',
    title: 'Temperature adjustment during expensive hours (e.g., -5 to reduce)',
    onChange: async (val) => {
      const nextConfig = ensurePriceOptimizationConfig(device.id);
      nextConfig.expensiveDelta = val;
      try {
        await savePriceOptimizationSettings();
      } catch (error) {
        await logSettingsError('Failed to save expensive price delta', error, 'priceOptimizationRow');
        await showToastError(error, 'Failed to save expensive price delta.');
      }
    },
  });

  return createDeviceRow({
    id: device.id,
    name: device.name,
    className: 'price-optimization-row',
    controls: [cheapInput, expensiveInput],
  });
};

export const renderPriceOptimization = (devices: TargetDeviceSnapshot[]) => {
  if (!priceOptimizationList) return;
  priceOptimizationList.innerHTML = '';

  const enabledDevices = (devices || []).filter((device) => {
    const config = state.priceOptimizationSettings[device.id];
    return resolveManagedState(device.id)
      && config?.enabled === true
      && supportsTemperatureDevice(device)
      && supportsPowerDevice(device);
  });

  if (enabledDevices.length === 0) {
    if (priceOptimizationSection) priceOptimizationSection.hidden = true;
    if (priceOptimizationEmpty) priceOptimizationEmpty.hidden = false;
    return;
  }

  if (priceOptimizationSection) priceOptimizationSection.hidden = false;
  if (priceOptimizationEmpty) priceOptimizationEmpty.hidden = true;

  enabledDevices.forEach((device) => {
    priceOptimizationList.appendChild(buildPriceOptimizationRow(device));
  });
};
