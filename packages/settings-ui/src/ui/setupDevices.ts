import { readHomeMembership } from './homeScope.ts';
import { setupSavePending } from './setupJourneyState.ts';
import { resolveDeviceManageability } from './deviceListPresentation.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import type { SetupDeviceChoices } from './views/SetupJourney.tsx';
import { supportsTemperatureDevice, supportsPowerDevice, type SettingsUiDeviceListItem } from './deviceUtils.ts';
import { resolveDeviceDetailControlMode, resolveDeviceDetailKind } from './deviceKind.ts';
import { resolveDeviceDetailControlState } from './deviceDetail/controlState.ts';
import { isSurplusTrackingDeviceShape } from './deviceDetail/solarSurplusTracking.ts';
import { isDumpLoadDeviceShape } from './deviceDetail/solarSurplus.ts';
import { hasActiveDeadlineObjective, resolveSurplusControlAvailable, state } from './state.ts';
import { SURPLUS_TRACKING_LABELS } from '../../../shared-domain/src/solarSurplusTrackingCopy.ts';

export type SolarSetupAction = {
  label: string;
  hint: string | null;
  configured: boolean;
};

// Discovery describes how to reach existing controls. It never authorizes a
// write or substitutes for the control's own runtime-aligned eligibility gate.
const solarSetupLabel = (device: SettingsUiDeviceListItem): string | null => {
  if (device.isBatteryOrSolar) return null;
  if (supportsTemperatureDevice(device)) return 'Use solar surplus';
  if (resolveDeviceDetailKind(device) === 'ev_charger') return SURPLUS_TRACKING_LABELS.ev_charger;
  const control = resolveDeviceDetailControlState(device, device.id);
  if (isSurplusTrackingDeviceShape(device, control) || resolveDeviceDetailControlMode(device) !== 'default') {
    return SURPLUS_TRACKING_LABELS.stepped;
  }
  return device.binaryControllable ? 'Run on solar surplus' : null;
};

const solarSetupHint = (device: SettingsUiDeviceListItem): string | null => {
  const control = resolveDeviceDetailControlState(device, device.id);
  if (!control.canManageDevice) return 'Open Setup to enable device control.';
  if (!supportsPowerDevice(device)) return 'This device needs a power reading.';
  if (!control.isManaged) return 'Turn on Managed by PELS first.';
  if (supportsTemperatureDevice(device)) {
    if (!control.canControlTemperature) {
      return 'Choose Return to mode target under When the temperature changes outside PELS.';
    }
  } else {
    if (!isSurplusTrackingDeviceShape(device, control) && !isDumpLoadDeviceShape(device, control)) {
      return 'Choose a suitable control model in Setup.';
    }
    if (state.controllableMap[device.id] !== true) return 'Turn on Power-limit control in Setup.';
    if (hasActiveDeadlineObjective(device.id)) {
      return 'Solar-only control can be changed after the active Smart task ends.';
    }
  }
  return resolveSurplusControlAvailable()
    ? null : 'Waiting for usable solar readings. Check the meter and solar devices in Homey.';
};

export const resolveSolarSetupAction = (device: SettingsUiDeviceListItem): SolarSetupAction | null => {
  const label = solarSetupLabel(device);
  if (!label) return null;
  return {
    label, hint: solarSetupHint(device),
    configured: state.priceOptimizationSettings[device.id]?.surplusWilling === true,
  };
};

const setupDeviceHint = (
  manageability: ReturnType<typeof resolveDeviceManageability>, solar: boolean,
): string | null => {
  if (manageability.nativeWiringRequired) return 'Enable device control in Setup.';
  if (solar) return null;
  return manageability.supportsPower ? 'PELS may lower or pause this device.' : 'PELS may adjust its temperature.';
};

export const readSetupDeviceChoices = (devices: SettingsUiDeviceListItem[], solar: boolean): SetupDeviceChoices => {
  const membership = readHomeMembership();
  if (!state.devicesLoaded || membership.state === 'loading') return { state: 'loading' };
  if (membership.state === 'unavailable') return { state: 'unavailable' };
  return { state: 'ready', devices: devices
    .filter((device) => !membership.runtimeActive || (membership.membershipByDeviceId[device.id] ?? 'main') === 'main')
    .flatMap((device) => {
      const manageability = resolveDeviceManageability(device);
      const action = resolveSolarSetupAction(device);
      if (!manageability.supportsManage || (solar && !action)) return [];
      return [{
        id: device.id,
        name: formatDisplayDeviceName(device.name),
        managed: manageability.isManaged,
        disabled: !state.initialLoadComplete || !manageability.canManage || setupSavePending(),
        hint: setupDeviceHint(manageability, solar),
        solar: action,
      }];
    }) };
};

