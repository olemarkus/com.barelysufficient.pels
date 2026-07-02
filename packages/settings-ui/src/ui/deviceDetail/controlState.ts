import {
  requiresNativeWiringForActivation,
  supportsManagedDevice,
  supportsPowerDevice,
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import { resolveManagedState } from '../state.ts';

export const resolveDeviceDetailControlState = (
  device: SettingsUiDeviceDetailItem | null,
  deviceId: string,
) => {
  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const supportsManage = supportsManagedDevice(supportsPower, supportsTemperature);
  const nativeWiringRequired = requiresNativeWiringForActivation(device);
  const canManageDevice = supportsManage && !nativeWiringRequired;
  return {
    supportsTemperature,
    supportsPower,
    canManageDevice,
    isManaged: canManageDevice && resolveManagedState(deviceId),
  };
};

// A price/surplus switch is on only for a managed temperature device, and is
// disabled (greyed) otherwise — the shared gate for both detail toggles.
export const setTemperatureGatedSwitch = (
  switchEl: { selected: boolean; disabled: boolean } | null,
  active: boolean | undefined,
  controlState: { supportsTemperature: boolean; isManaged: boolean },
): void => {
  if (!switchEl) return;
  /* eslint-disable no-param-reassign -- intentional DOM element mutation via a shared helper */
  switchEl.selected = controlState.supportsTemperature && controlState.isManaged && active === true;
  switchEl.disabled = !controlState.supportsTemperature || !controlState.isManaged;
  /* eslint-enable no-param-reassign */
};
