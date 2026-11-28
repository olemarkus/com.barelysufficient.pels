import {
  deviceDetailSurplusGridHint,
  deviceDetailSurplusGridLabel,
  deviceDetailSurplusGridOpt,
  deviceDetailSurplusGridRow,
  deviceDetailSurplusGridUnreadableHint,
  deviceDetailSurplusTrackDisabledHint,
  deviceDetailSurplusTrackHint,
  deviceDetailSurplusTrackLabel,
  deviceDetailSurplusTrackOpt,
  deviceDetailSurplusTrackPowerLimitHint,
  deviceDetailSurplusTrackRow,
  deviceDetailSurplusTrackSmartTaskNote,
} from '../dom.ts';
import {
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import {
  findLatestDevice,
  hasActiveDeadlineObjective,
  resolveSolarProductionReadable,
  resolveSurplusControlAvailable,
  state,
} from '../state.ts';
import { savePriceOptimizationPatch, SURPLUS_ONLY_PRICE_OPTIMIZATION_CONFIG } from './priceOptimizationPatch.ts';
import {
  resolveDeviceDetailControlMode,
  resolveDeviceDetailKind,
  type DeviceDetailControlMode,
} from '../deviceKind.ts';
import { resolveDeviceDetailControlState } from './controlState.ts';
import { hasUsableSteppedLoadLadder } from '../../../../shared-domain/src/deviceControlProfiles.ts';
import { vehicleChargingConsentMissing } from '../chargingSetupFacts.ts';
import {
  SURPLUS_GRID_WHEN_PANELS_STOP_HINT,
  SURPLUS_GRID_WHEN_PANELS_STOP_LABEL,
  SURPLUS_GRID_WHEN_PANELS_STOP_UNREADABLE_HINT,
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
 * modulate. An enabled target-power mode (an EV amp preset, or Continuous)
 * counts as a ladder before the device is refetched: switching to one clears
 * the local profile, and the runtime builds the ladder from the stored config,
 * which only survives normalization when it yields one.
 */
const TARGET_POWER_LADDER_MODES: ReadonlySet<DeviceDetailControlMode> = new Set<DeviceDetailControlMode>([
  'ev_charger_1_phase', 'ev_charger_3_phase', 'continuous',
]);

export const isSurplusTrackingDeviceShape = (
  device: SettingsUiDeviceDetailItem | null,
  controlState: { isManaged: boolean; canManageDevice: boolean },
): boolean => {
  if (!device) return false;
  if (!controlState.canManageDevice || !controlState.isManaged) return false;
  if (supportsTemperatureDevice(device)) return false;
  return hasUsableSteppedLoadLadder(device.steppedLoadProfile)
    || TARGET_POWER_LADDER_MODES.has(resolveDeviceDetailControlMode(device));
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
  if (deviceDetailSurplusGridOpt) {
    deviceDetailSurplusGridOpt.disabled = powerLimitOff || disabledBySmartTask;
  }
  if (deviceDetailSurplusTrackPowerLimitHint) {
    deviceDetailSurplusTrackPowerLimitHint.hidden = !powerLimitOff;
  }
  if (deviceDetailSurplusTrackDisabledHint) {
    deviceDetailSurplusTrackDisabledHint.hidden = !(disabledBySmartTask && !powerLimitOff);
  }
};

/**
 * "Charge from the grid when the panels stop" qualifies "Charge on solar
 * surplus", so it shows on a charger's page while that switch is on. A stored
 * choice outlives turning the surplus switch off and comes back with it.
 *
 * It is offered only where PELS can see the panels' production. Where it
 * cannot, a choice already on stays visible so it can be turned off, with a
 * line saying what it waits for.
 */
const syncGridWhenPanelsStopRow = (deviceId: string | null, surplusOn: boolean): void => {
  if (!deviceDetailSurplusGridRow) return;
  const selected = deviceId !== null && state.priceOptimizationSettings[deviceId]?.gridWhenPanelsStop === true;
  const readable = resolveSolarProductionReadable();
  const show = surplusOn && (readable || selected);
  deviceDetailSurplusGridRow.hidden = !show;
  if (deviceDetailSurplusGridUnreadableHint) deviceDetailSurplusGridUnreadableHint.hidden = readable;
  if (!deviceDetailSurplusGridOpt) return;
  deviceDetailSurplusGridOpt.selected = show && selected;
  if (!show) deviceDetailSurplusGridOpt.disabled = true;
};

const hideTrackingRow = (): void => {
  if (deviceDetailSurplusTrackOpt) {
    deviceDetailSurplusTrackOpt.selected = false;
    deviceDetailSurplusTrackOpt.disabled = true;
  }
  if (deviceDetailSurplusTrackDisabledHint) deviceDetailSurplusTrackDisabledHint.hidden = true;
  if (deviceDetailSurplusTrackPowerLimitHint) deviceDetailSurplusTrackPowerLimitHint.hidden = true;
};

const syncChargingSetupNotice = (deviceId: string | null, show: boolean): void => {
  const notice = document.getElementById('device-detail-solar-charging-setup');
  if (notice) notice.hidden = !show || deviceId === null || !vehicleChargingConsentMissing(deviceId);
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
export const setDeviceDetailSurplusTrackingControl = (
  deviceId: string | null,
  device: SettingsUiDeviceDetailItem | null,
): void => {
  if (!deviceDetailSurplusTrackRow || !deviceDetailSurplusTrackOpt) return;
  const controlState = resolveDeviceDetailControlState(device, deviceId ?? '');
  const shape = deviceId !== null && isSurplusTrackingDeviceShape(device, controlState);
  const optedIn = deviceId !== null
    && state.priceOptimizationSettings[deviceId]?.surplusWilling === true;
  const showRow = shape && (resolveSurplusControlAvailable() || optedIn);
  syncChargingSetupNotice(deviceId, showRow && optedIn);
  deviceDetailSurplusTrackRow.hidden = !showRow;
  if (!showRow || !deviceId || !device) {
    syncGridWhenPanelsStopRow(deviceId, false);
    hideTrackingRow();
    return;
  }
  applyTrackingCopy(device);
  deviceDetailSurplusTrackOpt.selected = optedIn;
  syncGridWhenPanelsStopRow(deviceId, optedIn && resolveCopyKind(device) === 'ev_charger');
  applyTrackingDisabledState(deviceId);
};

const applyTrackingCopy = (device: SettingsUiDeviceDetailItem): void => {
  const kind = resolveCopyKind(device);
  if (deviceDetailSurplusTrackLabel) {
    deviceDetailSurplusTrackLabel.textContent = SURPLUS_TRACKING_LABELS[kind];
    deviceDetailSurplusTrackOpt?.setAttribute('aria-label', SURPLUS_TRACKING_LABELS[kind]);
  }
  if (deviceDetailSurplusTrackHint) {
    deviceDetailSurplusTrackHint.textContent = SURPLUS_TRACKING_HINTS[kind];
  }
  // Shown once the switch is on (data-shown-when-on): what tracking means for a Smart task.
  if (deviceDetailSurplusTrackSmartTaskNote) {
    deviceDetailSurplusTrackSmartTaskNote.textContent = SURPLUS_TRACKING_SMART_TASK_NOTE;
  }
  if (deviceDetailSurplusGridLabel) deviceDetailSurplusGridLabel.textContent = SURPLUS_GRID_WHEN_PANELS_STOP_LABEL;
  deviceDetailSurplusGridOpt?.setAttribute('aria-label', SURPLUS_GRID_WHEN_PANELS_STOP_LABEL);
  if (deviceDetailSurplusGridHint) deviceDetailSurplusGridHint.textContent = SURPLUS_GRID_WHEN_PANELS_STOP_HINT;
  if (deviceDetailSurplusGridUnreadableHint) {
    deviceDetailSurplusGridUnreadableHint.textContent = SURPLUS_GRID_WHEN_PANELS_STOP_UNREADABLE_HINT;
  }
};

export const initDeviceDetailSurplusTrackingHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  revealChargingSetup: () => void;
}): void => {
  document.getElementById('device-detail-solar-charging-setup-action')?.addEventListener('click', () => {
    params.revealChargingSetup();
  });
  const save = async (
    patch: { surplusWilling: boolean } | { gridWhenPanelsStop: boolean },
  ): Promise<void> => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    const device = findLatestDevice(deviceId);
    const controlState = resolveDeviceDetailControlState(device, deviceId);
    // Shape-only, not the solar-offer gate: an owner opting OUT after their
    // solar device disappeared must still be able to save, or the escape hatch
    // above is dead.
    if (!isSurplusTrackingDeviceShape(device, controlState)) return;

    // An existing entry keeps its other fields and only flips the patched one.
    const rebind = (): void => {
      if (params.getCurrentDetailDeviceId() === deviceId) {
        setDeviceDetailSurplusTrackingControl(deviceId, findLatestDevice(deviceId));
      }
    };
    if (await savePriceOptimizationPatch(
      deviceId,
      patch,
      SURPLUS_ONLY_PRICE_OPTIMIZATION_CONFIG,
      'Failed to save solar surplus settings',
      rebind,
    )) rebind();
  };

  deviceDetailSurplusTrackOpt?.addEventListener('change', () => {
    void save({ surplusWilling: deviceDetailSurplusTrackOpt.selected });
  });
  deviceDetailSurplusGridOpt?.addEventListener('change', () => {
    void save({ gridWhenPanelsStop: deviceDetailSurplusGridOpt.selected });
  });
};
