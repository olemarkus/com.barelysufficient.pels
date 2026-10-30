import type { DeviceDetailFocus } from './cardActivation.ts';
import { readHomeMembership } from './homeScope.ts';
import { setupSavePending } from './setupJourneyState.ts';
import { resolveDeviceManageability } from './deviceListPresentation.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import type { SetupDeviceChoices } from './views/SetupJourney.tsx';
import {
  requiresNativeWiringForActivation, supportsTemperatureDevice, supportsPowerDevice, type SettingsUiDeviceListItem,
} from './deviceUtils.ts';
import { resolveDeviceDetailControlMode, resolveDeviceDetailKind } from './deviceKind.ts';
import { resolveDeviceDetailControlState } from './deviceDetail/controlState.ts';
import { isSurplusTrackingDeviceShape } from './deviceDetail/solarSurplusTracking.ts';
import { isDumpLoadDeviceShape } from './deviceDetail/solarSurplus.ts';
import { hasActiveDeadlineObjective, state } from './state.ts';
import { SURPLUS_TRACKING_LABELS } from '../../../shared-domain/src/solarSurplusTrackingCopy.ts';
import { isHomeBatteryClassKey } from '../../../shared-domain/src/batteryOrSolarRole.ts';
import { BATTERY_MANAGED_HINT, BATTERY_WATCH_MANAGED_HINT } from './deviceDetail/batterySection.ts';

export type SolarSetupAction = {
  label: string;
  hint: string | null;
  actionLabel: string;
  focus: DeviceDetailFocus;
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

type SolarSetupPrerequisite = { hint: string; focus: DeviceDetailFocus };

const solarSetupPrerequisite = (device: SettingsUiDeviceListItem): SolarSetupPrerequisite | null => {
  const control = resolveDeviceDetailControlState(device, device.id);
  if (requiresNativeWiringForActivation(device)) {
    return { hint: 'Turn on Use built-in device control in Setup.', focus: 'native-control' };
  }
  if (!supportsPowerDevice(device)) return { hint: 'This device needs a power reading.', focus: 'top' };
  if (!control.isManaged) return { hint: 'Turn on Managed by PELS first.', focus: 'managed' };
  if (supportsTemperatureDevice(device)) {
    return control.canControlTemperature ? null : {
      hint: 'Choose “Return to mode target” under “When the temperature changes outside PELS”.',
      focus: 'temperature-policy',
    };
  }
  if (!isSurplusTrackingDeviceShape(device, control) && !isDumpLoadDeviceShape(device, control)) {
    return {
      hint: resolveDeviceDetailKind(device) === 'ev_charger'
        ? 'Choose “EV 1-phase” or “EV 3-phase” under “Control model” to match the charger’s connection.'
        : 'Choose a suitable control model in Setup.',
      focus: 'control-model',
    };
  }
  if (state.controllableMap[device.id] !== true) {
    return { hint: 'Turn on Power-limit control in Setup.', focus: 'power-limit' };
  }
  if (hasActiveDeadlineObjective(device.id)) {
    return { hint: 'Solar-only control can be changed after the active Smart task ends.', focus: 'solar' };
  }
  // Waiting for the first surplus is not a prerequisite the owner can meet; the
  // step's header says it once instead of every card repeating it.
  return null;
};

const solarSetupActionLabel = (prerequisite: SolarSetupPrerequisite | null, label: string): string => {
  if (!prerequisite) return label;
  if (prerequisite.focus === 'top') return 'Device settings';
  if (prerequisite.focus === 'solar') return 'Solar settings';
  return 'Set up solar control';
};

export const resolveSolarSetupAction = (device: SettingsUiDeviceListItem): SolarSetupAction | null => {
  const label = solarSetupLabel(device);
  if (!label) return null;
  const prerequisite = solarSetupPrerequisite(device);
  return {
    label,
    hint: prerequisite?.hint ?? null,
    actionLabel: solarSetupActionLabel(prerequisite, label),
    focus: prerequisite?.focus ?? 'solar',
    configured: state.priceOptimizationSettings[device.id]?.surplusWilling === true,
  };
};

const setupDeviceHint = (
  device: SettingsUiDeviceListItem,
  manageability: ReturnType<typeof resolveDeviceManageability>,
): string | null => {
  if (manageability.nativeWiringRequired) return 'Enable device control in Setup.';
  // A battery is neither paused nor set to a temperature: say what its device page's Managed says.
  if (isHomeBatteryClassKey(device.deviceClass)) {
    return manageability.supportsPower ? BATTERY_MANAGED_HINT : BATTERY_WATCH_MANAGED_HINT;
  }
  return manageability.supportsPower ? 'PELS may lower or pause this device.' : 'PELS may adjust its temperature.';
};

export const readSetupDeviceChoices = (devices: SettingsUiDeviceListItem[]): SetupDeviceChoices => {
  const membership = readHomeMembership();
  if (!state.devicesLoaded || membership.state === 'loading') return { state: 'loading' };
  if (membership.state === 'unavailable') return { state: 'unavailable' };
  return { state: 'ready', devices: devices
    .filter((device) => (membership.membershipByDeviceId[device.id] ?? 'main') === 'main')
    .flatMap((device) => {
      const manageability = resolveDeviceManageability(device);
      if (!manageability.supportsManage) return [];
      return [{
        id: device.id,
        name: formatDisplayDeviceName(device.name),
        managed: manageability.isManaged,
        disabled: !state.initialLoadComplete || !manageability.canManage || setupSavePending(),
        hint: setupDeviceHint(device, manageability),
      }];
    }) };
};

