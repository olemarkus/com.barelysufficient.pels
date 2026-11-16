import { supportsTemperatureAdjustments, temperatureAdjustmentGateHint } from './temperaturePolicy.ts';
import {
  deviceDetailCheapDelta,
  deviceDetailDeltaFields,
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
import { renderPriceConfigDevices } from '../priceConfig.ts';
import { findLatestDevice, resolveManagedState, state, defaultPriceOptimizationConfig } from '../state.ts';
import { savePriceOptimizationPatch } from './priceOptimizationPatch.ts';
import {
  encodePriceAdjustment,
  type PriceAdjustmentKind,
} from '../../../../shared-domain/src/settings/priceOptimization.ts';

const readPriceAdjustment = (kind: PriceAdjustmentKind, value: string | undefined): number => (
  encodePriceAdjustment(kind, Math.abs(Number.parseFloat(value || '')))?.value
    ?? (kind === 'cheap_hour_boost' ? 5 : -5)
);

const readPriceOptInputs = (): { enabled: boolean; cheapDelta: number; expensiveDelta: number } => ({
  enabled: deviceDetailPriceOpt?.selected || false,
  // Both editors display magnitudes; the shared owner encodes the stored sign.
  cheapDelta: readPriceAdjustment('cheap_hour_boost', deviceDetailCheapDelta?.value),
  expensiveDelta: readPriceAdjustment('expensive_hour_reduction', deviceDetailExpensiveDelta?.value),
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

// Why price response cannot apply right now, while it may: the switch is
// disabled and, if it is on, its fields are too. Only kind-inapplicable devices
// (no temperature target at all) hide the section outright.
const resolveDeltaGateHint = (params: {
  canControlTemperature: boolean;
  disabledHint: string;
  isManaged: boolean;
}): string | null => {
  if (!params.canControlTemperature) {
    return params.disabledHint;
  }
  if (!params.isManaged) return 'Turn on Managed by PELS in Setup to use price response.';
  return null;
};

export const updateDeltaSectionVisibility = (device: SettingsUiDeviceDetailItem | null) => {
  if (!deviceDetailDeltaSection || !deviceDetailPriceOpt) return;

  if (!supportsTemperatureDevice(device)) {
    deviceDetailDeltaSection.style.display = 'none';
    return;
  }

  const isManaged = device ? resolveManagedState(device.id) : false;
  const gateHint = resolveDeltaGateHint({
    canControlTemperature: supportsTemperatureAdjustments(device),
    disabledHint: temperatureAdjustmentGateHint(device),
    isManaged,
  });
  deviceDetailDeltaSection.style.display = 'block';
  // The fields are Price-based control's settings: hidden while it is off.
  if (deviceDetailDeltaFields) deviceDetailDeltaFields.hidden = !deviceDetailPriceOpt.selected;
  // The direction note is for a device that can cool: one that reports a mode.
  const directionHint = document.getElementById('device-detail-delta-direction-hint');
  if (directionHint) directionHint.hidden = device?.capabilities?.includes('thermostat_mode') !== true;
  if (deviceDetailCheapDelta) deviceDetailCheapDelta.disabled = gateHint !== null;
  if (deviceDetailExpensiveDelta) deviceDetailExpensiveDelta.disabled = gateHint !== null;
  if (deviceDetailDeltaGateHint) {
    deviceDetailDeltaGateHint.textContent = gateHint ?? '';
    deviceDetailDeltaGateHint.hidden = gateHint === null;
  }
};

export const initDeviceDetailPriceOptHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
}) => {
  const renderPriceOptDependents = () => {
    renderDevices(state.latestDevices);
    renderPriceConfigDevices();
    const currentDetailDeviceId = params.getCurrentDetailDeviceId();
    updateDeltaSectionVisibility(currentDetailDeviceId ? findLatestDevice(currentDetailDeviceId) : null);
  };

  const autoSavePriceOpt = async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;

    const device = findLatestDevice(deviceId);
    if (!supportsTemperatureAdjustments(device)) return;

    const { enabled, cheapDelta, expensiveDelta } = readPriceOptInputs();
    const saved = await savePriceOptimizationPatch(
      deviceId,
      { enabled, cheapDelta, expensiveDelta, priceConfigured: true },
      defaultPriceOptimizationConfig,
      'Failed to save price optimization settings',
      () => {
        // Re-bind the inputs and toggle only if the user is still on this
        // device's detail panel. Otherwise the rollback would overwrite the
        // visible inputs with values from the previous device.
        if (params.getCurrentDetailDeviceId() === deviceId) {
          setDeviceDetailDeltaValues(deviceId);
          const restored = state.priceOptimizationSettings[deviceId];
          if (deviceDetailPriceOpt) deviceDetailPriceOpt.selected = restored?.enabled ?? false;
        }
        renderPriceOptDependents();
      },
    );
    if (!saved) return;
    // Show what was saved: a typed "-3" is stored, and applied, as 3.
    if (params.getCurrentDetailDeviceId() === deviceId) setDeviceDetailDeltaValues(deviceId);
    renderPriceOptDependents();
  };

  // The fields follow the switch at once, before the save resolves.
  deviceDetailPriceOpt?.addEventListener('change', () => {
    const deviceId = params.getCurrentDetailDeviceId();
    updateDeltaSectionVisibility(deviceId ? findLatestDevice(deviceId) : null);
  });
  deviceDetailPriceOpt?.addEventListener('change', autoSavePriceOpt);
  deviceDetailCheapDelta?.addEventListener('change', autoSavePriceOpt);
  deviceDetailExpensiveDelta?.addEventListener('change', autoSavePriceOpt);
};
