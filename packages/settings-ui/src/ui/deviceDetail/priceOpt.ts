import { supportsTemperatureAdjustments, temperatureAdjustmentGateHint } from './temperaturePolicy.ts';
import {
  deviceDetailCheapDelta,
  deviceDetailDeltaGateHint,
  deviceDetailDeltaSection,
  deviceDetailExpensiveDelta,
  deviceDetailPriceOpt,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import {
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
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
  // Both fields are magnitudes — the labels say "boost" and "reduction", and the
  // Prices tab's editor of the same two settings cannot express a negative
  // (`DELTA_MIN = 0`). This one could, which left one stored field with two
  // conventions; the stored sign is normalized here so it has one.
  cheapDelta: Math.abs(parsePriceDeltaInput(deviceDetailCheapDelta?.value, 5)),
  expensiveDelta: -Math.abs(parsePriceDeltaInput(deviceDetailExpensiveDelta?.value, 5)),
});

export const setDeviceDetailDeltaValues = (deviceId: string) => {
  const priceConfig = state.priceOptimizationSettings[deviceId];
  // Both fields render magnitudes, whatever sign an older save stored: the
  // planner applies each delta by its magnitude, so that is the number that
  // takes effect.
  if (deviceDetailCheapDelta) {
    deviceDetailCheapDelta.value = Math.abs(priceConfig?.cheapDelta ?? 5).toString();
  }
  if (deviceDetailExpensiveDelta) {
    deviceDetailExpensiveDelta.value = Math.abs(priceConfig?.expensiveDelta ?? -5).toString();
  }
};

// Why the delta fields are inert right now. Applicable-but-unavailable renders
// visible-but-disabled with this hint; only kind-inapplicable devices (no
// temperature target at all) hide the section outright.
const resolveDeltaGateHint = (params: {
  canControlTemperature: boolean;
  disabledHint: string;
  isManaged: boolean;
  selected: boolean;
}): string | null => {
  if (!params.canControlTemperature) {
    return params.disabledHint;
  }
  if (!params.isManaged) return 'Turn on Managed by PELS in Setup to use price response.';
  if (!params.selected) {
    return 'Turn on Price-based control in Setup to adjust this device’s temperature with electricity prices.';
  }
  return null;
};

export const updateDeltaSectionVisibility = (params: {
  currentDetailDeviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}) => {
  if (!deviceDetailDeltaSection || !deviceDetailPriceOpt) return;

  const device = params.currentDetailDeviceId ? params.getDeviceById(params.currentDetailDeviceId) : null;
  if (!supportsTemperatureDevice(device)) {
    deviceDetailDeltaSection.style.display = 'none';
    return;
  }

  const isManaged = params.currentDetailDeviceId ? resolveManagedState(params.currentDetailDeviceId) : false;
  const gateHint = resolveDeltaGateHint({
    canControlTemperature: supportsTemperatureAdjustments(device),
    disabledHint: temperatureAdjustmentGateHint(device),
    isManaged,
    selected: deviceDetailPriceOpt.selected,
  });
  deviceDetailDeltaSection.style.display = 'block';
  if (deviceDetailCheapDelta) deviceDetailCheapDelta.disabled = gateHint !== null;
  if (deviceDetailExpensiveDelta) deviceDetailExpensiveDelta.disabled = gateHint !== null;
  if (deviceDetailDeltaGateHint) {
    deviceDetailDeltaGateHint.textContent = gateHint ?? '';
    deviceDetailDeltaGateHint.hidden = gateHint === null;
  }
};

export const initDeviceDetailPriceOptHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
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
    if (!supportsTemperatureAdjustments(device)) return;

    const { enabled, cheapDelta, expensiveDelta } = readPriceOptInputs();
    // Snapshot only this device's three fields before the optimistic mutation
    // so a failed Homey write can be rolled back. Replacing the whole map
    // (the earlier approach) clobbered newer persisted edits from overlapping
    // handlers.
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
      // Show what was saved: a typed "-3" is stored, and applied, as 3.
      if (params.getCurrentDetailDeviceId() === deviceId) setDeviceDetailDeltaValues(deviceId);
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
      // visible inputs with values from the previous device.
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
