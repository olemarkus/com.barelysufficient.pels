import {
  deviceDetailSurplusTrackDisabledHint,
  deviceDetailSurplusTrackHint,
  deviceDetailSurplusTrackLabel,
  deviceDetailSurplusTrackOpt,
  deviceDetailSurplusTrackPowerLimitHint,
  deviceDetailSurplusTrackRow,
} from '../dom.ts';
import {
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import { logSettingsError } from '../logging.ts';
import { savePriceOptimizationSettings } from '../priceOptimization.ts';
import {
  hasActiveDeadlineObjective,
  resolveSurplusControlAvailable,
  state,
  type PriceOptimizationConfig,
} from '../state.ts';
import { showToastError } from '../toast.ts';
import { resolveDeviceDetailKind } from '../deviceKind.ts';
import { resolveDeviceDetailControlState } from './controlState.ts';
import { hasUsableSteppedLoadLadder } from '../../../../contracts/src/deviceControlProfiles.ts';
import {
  SURPLUS_TRACKING_HINTS,
  SURPLUS_TRACKING_LABELS,
  SURPLUS_TRACKING_SMART_TASK_NOTE,
  type SurplusTrackingCopyKind,
} from '../../../../shared-domain/src/solarSurplusTrackingCopy.ts';

/**
 * Device shapes that earn the "match solar surplus" control — the settings-UI
 * mirror of the runtime `resolveSurplusTrackingPosture`. Kept in step with it
 * deliberately: a device the runtime would never stamp must not be offered a
 * toggle that silently does nothing.
 *
 * The discriminant is the step ladder, not the device kind. An EV charger under
 * a current-control preset qualifies because it is a stepped load; so does a
 * hand-configured stepped water heater. What is excluded is a temperature
 * device (that modality is the setpoint lift) and anything with no ladder to
 * modulate.
 */
const isSurplusTrackingDeviceShape = (
  device: SettingsUiDeviceDetailItem | null,
  controlState: { isManaged: boolean; canManageDevice: boolean },
): boolean => {
  if (!device) return false;
  if (!controlState.canManageDevice || !controlState.isManaged) return false;
  if (supportsTemperatureDevice(device)) return false;
  return hasUsableSteppedLoadLadder(device.steppedLoadProfile);
};

const resolveCopyKind = (device: SettingsUiDeviceDetailItem): SurplusTrackingCopyKind => (
  resolveDeviceDetailKind(device) === 'ev_charger' ? 'ev_charger' : 'stepped'
);

// Same reasoning as the dump load's: the runtime gates the posture on
// `isCapacityControlEnabled` (managed AND power-limit-controllable), so mirror
// the controllable half here or the toggle silently does nothing.
const isPowerLimitControlOn = (deviceId: string): boolean => state.controllableMap[deviceId] === true;

const applyTrackingDisabledState = (deviceId: string): void => {
  const powerLimitOff = !isPowerLimitControlOn(deviceId);
  const disabledBySmartTask = hasActiveDeadlineObjective(deviceId);
  if (deviceDetailSurplusTrackOpt) {
    deviceDetailSurplusTrackOpt.disabled = powerLimitOff || disabledBySmartTask;
  }
  if (deviceDetailSurplusTrackPowerLimitHint) {
    deviceDetailSurplusTrackPowerLimitHint.hidden = !powerLimitOff;
  }
  if (deviceDetailSurplusTrackDisabledHint) {
    deviceDetailSurplusTrackDisabledHint.hidden = !(disabledBySmartTask && !powerLimitOff);
  }
};

const hideTrackingRow = (): void => {
  if (deviceDetailSurplusTrackOpt) {
    deviceDetailSurplusTrackOpt.selected = false;
    deviceDetailSurplusTrackOpt.disabled = true;
  }
  if (deviceDetailSurplusTrackDisabledHint) deviceDetailSurplusTrackDisabledHint.hidden = true;
  if (deviceDetailSurplusTrackPowerLimitHint) deviceDetailSurplusTrackPowerLimitHint.hidden = true;
};

/**
 * Sync the "match solar surplus" toggle row for the open device. Shown when the
 * device is a fresh candidate (shape-valid AND the home has solar) OR is ALREADY
 * opted in — the same escape hatch the dump load has, so an opt-OUT stays
 * reachable if the solar device later disappears.
 *
 * One toggle is the whole control. What the device does when the surplus runs
 * out is not asked here: it stops, and where it parks is the answer the Power
 * limiting section already gives for every other kind of stop.
 */
export const setDeviceDetailSurplusTrackingControl = (params: {
  deviceId: string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}): void => {
  if (!deviceDetailSurplusTrackRow || !deviceDetailSurplusTrackOpt) return;
  const device = params.deviceId ? params.getDeviceById(params.deviceId) : null;
  const controlState = resolveDeviceDetailControlState(device, params.deviceId ?? '');
  const shape = params.deviceId !== null && isSurplusTrackingDeviceShape(device, controlState);
  const optedIn = params.deviceId !== null
    && state.priceOptimizationSettings[params.deviceId]?.surplusWilling === true;
  const showRow = shape && (resolveSurplusControlAvailable() || optedIn);
  deviceDetailSurplusTrackRow.hidden = !showRow;
  if (!showRow || !params.deviceId || !device) {
    hideTrackingRow();
    return;
  }
  applyTrackingCopy(device);
  deviceDetailSurplusTrackOpt.selected = optedIn;
  applyTrackingDisabledState(params.deviceId);
};

const applyTrackingCopy = (device: SettingsUiDeviceDetailItem): void => {
  const kind = resolveCopyKind(device);
  if (deviceDetailSurplusTrackLabel) {
    deviceDetailSurplusTrackLabel.textContent = SURPLUS_TRACKING_LABELS[kind];
  }
  if (deviceDetailSurplusTrackHint) {
    deviceDetailSurplusTrackHint.textContent
      = `${SURPLUS_TRACKING_HINTS[kind]} ${SURPLUS_TRACKING_SMART_TASK_NOTE}`;
  }
};

// A fresh opt-in writes a full valid blob entry: price-response off and zero
// deltas (a stepped load has no setpoint to shift), with only the surplus fields
// carrying meaning. An existing entry keeps its other fields.
const buildTrackingConfig = (
  existing: PriceOptimizationConfig | undefined,
  surplusWilling: boolean,
): PriceOptimizationConfig => (
  existing
    ? { ...existing, surplusWilling }
    : { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling }
);

export const initDeviceDetailSurplusTrackingHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}): void => {
  const save = async (surplusWilling: boolean): Promise<void> => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    const device = params.getDeviceById(deviceId);
    const controlState = resolveDeviceDetailControlState(device, deviceId);
    // Shape-only, not the solar-offer gate: an owner opting OUT after their
    // solar device disappeared must still be able to save, or the escape hatch
    // above is dead.
    if (!isSurplusTrackingDeviceShape(device, controlState)) return;

    const previous = state.priceOptimizationSettings[deviceId];
    state.priceOptimizationSettings[deviceId] = buildTrackingConfig(previous, surplusWilling);

    try {
      await savePriceOptimizationSettings();
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailSurplusTrackingControl({ deviceId, getDeviceById: params.getDeviceById });
      }
    } catch (error) {
      // Roll back only if no newer edit landed while the save was in flight.
      const current = state.priceOptimizationSettings[deviceId];
      if (current && current.surplusWilling === surplusWilling) {
        if (previous) {
          state.priceOptimizationSettings[deviceId] = previous;
        } else {
          delete state.priceOptimizationSettings[deviceId];
        }
      }
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailSurplusTrackingControl({ deviceId, getDeviceById: params.getDeviceById });
      }
      await logSettingsError('Failed to save solar surplus settings', error, 'device detail');
      await showToastError(error, 'Failed to save solar surplus settings.');
    }
  };

  deviceDetailSurplusTrackOpt?.addEventListener('change', () => {
    void save(deviceDetailSurplusTrackOpt.selected);
  });
};
