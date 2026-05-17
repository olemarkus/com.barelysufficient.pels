import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  deviceDetailCheapDelta,
  deviceDetailDeltaSection,
  deviceDetailExpensiveDelta,
  deviceDetailPriceOpt,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import { supportsTemperatureDevice } from '../deviceUtils.ts';
import { logSettingsError } from '../logging.ts';
import {
  renderPriceOptimization,
  savePriceOptimizationSettings,
} from '../priceOptimization.ts';
import { resolveManagedState, state, defaultPriceOptimizationConfig } from '../state.ts';
import { showToastError } from '../toast.ts';

const ensurePriceOptimizationConfig = (deviceId: string) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { ...defaultPriceOptimizationConfig };
  }
  return state.priceOptimizationSettings[deviceId];
};

const parsePriceDeltaInput = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value || '');
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < -20 || parsed > 20) return fallback;
  return parsed;
};

const readPriceOptInputs = (): { enabled: boolean; cheapDelta: number; expensiveDelta: number } => ({
  enabled: deviceDetailPriceOpt?.selected || false,
  cheapDelta: parsePriceDeltaInput(deviceDetailCheapDelta?.value, 5),
  expensiveDelta: parsePriceDeltaInput(deviceDetailExpensiveDelta?.value, -5),
});

export const setDeviceDetailDeltaValues = (deviceId: string) => {
  const priceConfig = state.priceOptimizationSettings[deviceId];
  if (deviceDetailCheapDelta) {
    deviceDetailCheapDelta.value = (priceConfig?.cheapDelta ?? 5).toString();
  }
  if (deviceDetailExpensiveDelta) {
    deviceDetailExpensiveDelta.value = (priceConfig?.expensiveDelta ?? -5).toString();
  }
};

export const updateDeltaSectionVisibility = (params: {
  currentDetailDeviceId: string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
}) => {
  if (!deviceDetailDeltaSection || !deviceDetailPriceOpt) return;

  const device = params.currentDetailDeviceId ? params.getDeviceById(params.currentDetailDeviceId) : null;
  if (!supportsTemperatureDevice(device)) {
    deviceDetailDeltaSection.style.display = 'none';
    return;
  }

  const isManaged = params.currentDetailDeviceId ? resolveManagedState(params.currentDetailDeviceId) : false;
  deviceDetailDeltaSection.style.display = deviceDetailPriceOpt.selected && isManaged ? 'block' : 'none';
};

export const initDeviceDetailPriceOptHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
}) => {
  const renderPriceOptDependents = () => {
    renderDevices(state.latestDevices);
    renderPriceOptimization(state.latestDevices);
    updateDeltaSectionVisibility({
      currentDetailDeviceId: params.getCurrentDetailDeviceId(),
      getDeviceById: params.getDeviceById,
    });
  };

  const autoSavePriceOpt = async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;

    const device = params.getDeviceById(deviceId);
    if (!supportsTemperatureDevice(device)) return;

    const { enabled, cheapDelta, expensiveDelta } = readPriceOptInputs();
    // Snapshot only this device's three fields before the optimistic mutation
    // so a failed Homey write can be rolled back. Replacing the whole map
    // (the earlier approach) clobbered newer persisted edits from overlapping
    // handlers (TODO 735 follow-up).
    const config = ensurePriceOptimizationConfig(deviceId);
    const previousValues = {
      enabled: config.enabled,
      cheapDelta: config.cheapDelta,
      expensiveDelta: config.expensiveDelta,
    };
    config.enabled = enabled;
    config.cheapDelta = cheapDelta;
    config.expensiveDelta = expensiveDelta;

    try {
      await savePriceOptimizationSettings();
      renderPriceOptDependents();
    } catch (error) {
      // Roll back this device's fields only if a later successful save has
      // not already overwritten them.
      const current = state.priceOptimizationSettings[deviceId];
      if (current
        && current.enabled === enabled
        && current.cheapDelta === cheapDelta
        && current.expensiveDelta === expensiveDelta) {
        Object.assign(current, previousValues);
      }
      // Re-bind the inputs and toggle only if the user is still on this
      // device's detail panel. Otherwise the rollback would overwrite the
      // visible inputs with values from the previous device (TODO 735 follow-up).
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailDeltaValues(deviceId);
        const restored = state.priceOptimizationSettings[deviceId];
        if (deviceDetailPriceOpt) deviceDetailPriceOpt.selected = restored?.enabled ?? false;
      }
      renderPriceOptDependents();
      await logSettingsError('Failed to save price optimization settings', error, 'device detail');
      await showToastError(error, 'Failed to save price optimization settings.');
    }
  };

  deviceDetailPriceOpt?.addEventListener('change', autoSavePriceOpt);
  deviceDetailCheapDelta?.addEventListener('change', autoSavePriceOpt);
  deviceDetailExpensiveDelta?.addEventListener('change', autoSavePriceOpt);
};
