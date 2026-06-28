import {
  deviceDetailSurplusDelta,
  deviceDetailSurplusOpt,
  deviceDetailSurplusSection,
} from '../dom.ts';
import { supportsTemperatureDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { logSettingsError } from '../logging.ts';
import { savePriceOptimizationSettings } from '../priceOptimization.ts';
import { resolveManagedState, state, defaultPriceOptimizationConfig } from '../state.ts';
import { showToastError } from '../toast.ts';

const ensurePriceOptimizationConfig = (deviceId: string) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { ...defaultPriceOptimizationConfig };
  }
  return state.priceOptimizationSettings[deviceId];
};

const parseSurplusDeltaInput = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value || '');
  // Raise-only and bounded; a non-finite, negative, or wild value snaps to the default.
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 20) return fallback;
  return parsed;
};

const readSurplusInputs = (): { surplusWilling: boolean; surplusDelta: number } => ({
  surplusWilling: deviceDetailSurplusOpt?.selected || false,
  surplusDelta: parseSurplusDeltaInput(deviceDetailSurplusDelta?.value, 2),
});

export const setDeviceDetailSurplusValues = (deviceId: string) => {
  const config = state.priceOptimizationSettings[deviceId];
  if (deviceDetailSurplusDelta) {
    deviceDetailSurplusDelta.value = (config?.surplusDelta ?? 2).toString();
  }
};

export const updateSurplusSectionVisibility = (params: {
  currentDetailDeviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}) => {
  if (!deviceDetailSurplusSection || !deviceDetailSurplusOpt) return;
  const device = params.currentDetailDeviceId ? params.getDeviceById(params.currentDetailDeviceId) : null;
  const isManaged = params.currentDetailDeviceId ? resolveManagedState(params.currentDetailDeviceId) : false;
  // Field-only section, shown only when the "Use solar surplus" toggle (in the
  // Control section) is on — mirrors how "Price response" gates on its switch.
  // Solar-only: gated on the home having a tracked solar/PV device, so it never appears
  // in a home that does not export; and only on a managed temperature device (the only
  // kind that self-consumes by raising a setpoint).
  deviceDetailSurplusSection.style.display
    = state.hasManagedSolarDevice && supportsTemperatureDevice(device) && isManaged && deviceDetailSurplusOpt.selected
      ? 'block' : 'none';
};

export const initDeviceDetailSurplusOptHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}) => {
  const autoSaveSurplus = async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    const device = params.getDeviceById(deviceId);
    if (!supportsTemperatureDevice(device)) return;

    const { surplusWilling, surplusDelta } = readSurplusInputs();
    // Snapshot only this device's surplus fields before the optimistic mutation so
    // a failed Homey write can be rolled back without clobbering newer edits.
    const config = ensurePriceOptimizationConfig(deviceId);
    const previousValues = { surplusWilling: config.surplusWilling, surplusDelta: config.surplusDelta };
    config.surplusWilling = surplusWilling;
    config.surplusDelta = surplusDelta;

    try {
      await savePriceOptimizationSettings();
      // Only re-bind if the user is still on this device's panel — a late save for
      // device A must not rewrite device B's open panel (mirrors priceOpt). Re-binds
      // the delta input to the saved (snapped) value so an out-of-range entry doesn't
      // leave the field showing a number we didn't persist, and re-evaluates the
      // section's visibility against the current switch state.
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailSurplusValues(deviceId);
        updateSurplusSectionVisibility({ currentDetailDeviceId: deviceId, getDeviceById: params.getDeviceById });
      }
    } catch (error) {
      const current = state.priceOptimizationSettings[deviceId];
      if (current
        && current.surplusWilling === surplusWilling
        && current.surplusDelta === surplusDelta) {
        Object.assign(current, previousValues);
      }
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailSurplusValues(deviceId);
        const restored = state.priceOptimizationSettings[deviceId];
        if (deviceDetailSurplusOpt) deviceDetailSurplusOpt.selected = restored?.surplusWilling ?? false;
      }
      await logSettingsError('Failed to save solar surplus settings', error, 'device detail');
      await showToastError(error, 'Failed to save solar surplus settings.');
    }
  };

  deviceDetailSurplusOpt?.addEventListener('change', autoSaveSurplus);
  deviceDetailSurplusDelta?.addEventListener('change', autoSaveSurplus);
};
