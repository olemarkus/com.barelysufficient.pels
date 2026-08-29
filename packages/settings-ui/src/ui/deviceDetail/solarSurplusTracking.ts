import {
  deviceDetailSurplusFloor,
  deviceDetailSurplusFloorHint,
  deviceDetailSurplusTrackDisabledHint,
  deviceDetailSurplusTrackGateHint,
  deviceDetailSurplusTrackHint,
  deviceDetailSurplusTrackLabel,
  deviceDetailSurplusTrackLead,
  deviceDetailSurplusTrackOpt,
  deviceDetailSurplusTrackPowerLimitHint,
  deviceDetailSurplusTrackRow,
  deviceDetailSurplusTrackSection,
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
  type SurplusFloorPolicy,
} from '../state.ts';
import { showToastError } from '../toast.ts';
import { resolveDeviceDetailKind } from '../deviceKind.ts';
import { resolveDeviceDetailControlState } from './controlState.ts';
import {
  getSteppedLoadLowestActiveStep,
  hasUsableSteppedLoadLadder,
} from '../../../../contracts/src/deviceControlProfiles.ts';
import { resolveTargetPowerFloorW } from '../../../../shared-domain/src/targetPowerLadder.ts';
import { getStoredTargetPowerConfig } from '../deviceControlProfiles.ts';
import { readSurplusFloorPolicy } from '../../../../shared-domain/src/settings/surplusFloor.ts';
import {
  resolveSurplusFloorHint,
  SURPLUS_TRACKING_HINTS,
  SURPLUS_TRACKING_LABELS,
  SURPLUS_TRACKING_LEADS,
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
  return resolveLadderFloorKw(device) !== undefined;
};

/**
 * The device's own lowest running level, in kW.
 *
 * Read from the EFFECTIVE target-power config — the stored draft first, exactly
 * as `resolveDeviceDetailControlMode` and the rest of this panel read it. That
 * matters here more than anywhere: an owner switching the control mode from EV
 * 1-phase to 3-phase must see the floor hint change from about 1.4 kW to about
 * 4.1 kW as they do it. Reading the saved snapshot instead would show them the
 * old number at the exact moment they are deciding, and the number is the whole
 * point of the setting.
 *
 * Falls back to the device's own ladder for a hand-configured stepped load with
 * no target-power config. `resolveTargetPowerFloorW` is the same derivation the
 * real ladder is built from, so the two cannot drift.
 */
const resolveLadderFloorKw = (device: SettingsUiDeviceDetailItem): number | undefined => {
  const config = getStoredTargetPowerConfig(device.id) ?? device.targetPowerConfig;
  if (config && config.enabled !== false) {
    const floorW = resolveTargetPowerFloorW(config);
    if (floorW !== undefined && floorW > 0) return floorW / 1000;
  }
  const profile = device.steppedLoadProfile;
  if (!hasUsableSteppedLoadLadder(profile)) return undefined;
  const floor = getSteppedLoadLowestActiveStep(profile as NonNullable<typeof profile>);
  if (!floor || !Number.isFinite(floor.planningPowerW) || floor.planningPowerW <= 0) return undefined;
  return floor.planningPowerW / 1000;
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
 * Sync the "match solar surplus" toggle row and its floor section for the open
 * device. Shown when the device is a fresh candidate (shape-valid AND the home
 * has solar) OR is ALREADY opted in — the same escape hatch the dump load has,
 * so an opt-OUT stays reachable if the solar device later disappears.
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
    if (deviceDetailSurplusTrackSection) deviceDetailSurplusTrackSection.hidden = true;
    return;
  }
  applyTrackingCopy(device);
  deviceDetailSurplusTrackOpt.selected = optedIn;
  applyTrackingDisabledState(params.deviceId);
  applyFloorSection(params.deviceId, device, optedIn);
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
  if (deviceDetailSurplusTrackLead) {
    deviceDetailSurplusTrackLead.textContent = SURPLUS_TRACKING_LEADS[kind];
  }
};

/**
 * The floor section only means anything once the device is opted in, so it is
 * hidden until then rather than shown greyed out — an owner who has not turned
 * the feature on has no decision to make here.
 */
const applyFloorSection = (
  deviceId: string,
  device: SettingsUiDeviceDetailItem,
  optedIn: boolean,
): void => {
  if (deviceDetailSurplusTrackSection) deviceDetailSurplusTrackSection.hidden = !optedIn;
  if (!optedIn) return;
  if (deviceDetailSurplusFloor) {
    deviceDetailSurplusFloor.value = readSurplusFloorPolicy(
      state.priceOptimizationSettings[deviceId]?.surplusFloor,
    );
  }
  if (deviceDetailSurplusFloorHint) {
    deviceDetailSurplusFloorHint.textContent = resolveSurplusFloorHint(
      resolveCopyKind(device),
      resolveLadderFloorKw(device),
    );
  }
  const powerLimitOff = !isPowerLimitControlOn(deviceId);
  if (deviceDetailSurplusTrackGateHint) {
    deviceDetailSurplusTrackGateHint.textContent = powerLimitOff
      ? 'Turn on Power-limit control in Setup — PELS needs it to set this device\'s level.'
      : '';
    deviceDetailSurplusTrackGateHint.hidden = !powerLimitOff;
  }
};

// A fresh opt-in writes a full valid blob entry: price-response off and zero
// deltas (a stepped load has no setpoint to shift), with only the surplus fields
// carrying meaning. An existing entry keeps its other fields.
const buildTrackingConfig = (
  existing: PriceOptimizationConfig | undefined,
  fields: { surplusWilling?: boolean; surplusFloor?: SurplusFloorPolicy },
): PriceOptimizationConfig => (
  existing
    ? { ...existing, ...fields }
    : { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: false, ...fields }
);

export const initDeviceDetailSurplusTrackingHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
}): void => {
  const save = async (
    fields: { surplusWilling?: boolean; surplusFloor?: SurplusFloorPolicy },
  ): Promise<void> => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    const device = params.getDeviceById(deviceId);
    const controlState = resolveDeviceDetailControlState(device, deviceId);
    // Shape-only, not the solar-offer gate: an owner opting OUT after their
    // solar device disappeared must still be able to save, or the escape hatch
    // above is dead.
    if (!isSurplusTrackingDeviceShape(device, controlState)) return;

    const previous = state.priceOptimizationSettings[deviceId];
    state.priceOptimizationSettings[deviceId] = buildTrackingConfig(previous, fields);

    try {
      await savePriceOptimizationSettings();
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailSurplusTrackingControl({ deviceId, getDeviceById: params.getDeviceById });
      }
    } catch (error) {
      // Roll back only if no newer edit landed while the save was in flight.
      const current = state.priceOptimizationSettings[deviceId];
      const unchanged = current
        && (fields.surplusWilling === undefined || current.surplusWilling === fields.surplusWilling)
        && (fields.surplusFloor === undefined || current.surplusFloor === fields.surplusFloor);
      if (unchanged) {
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
    void save({ surplusWilling: deviceDetailSurplusTrackOpt.selected });
  });
  deviceDetailSurplusFloor?.addEventListener('change', () => {
    void save({ surplusFloor: readSurplusFloorPolicy(deviceDetailSurplusFloor.value) });
  });
};
