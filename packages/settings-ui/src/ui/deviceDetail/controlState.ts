import { supportsTemperatureAdjustments, supportsPowerLimiting } from './temperaturePolicy.ts';
import {
  requiresNativeWiringForActivation,
  supportsPowerDevice,
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import {
  isBatteryControlReadable,
  resolveBatteryPowerLimitOn,
  resolveManagedState,
  state,
} from '../state.ts';
import { isHomeBatteryClassKey } from '../../../../shared-domain/src/batteryOrSolarRole.ts';

export const resolveDeviceDetailControlState = (
  device: SettingsUiDeviceDetailItem | null,
  deviceId: string,
) => {
  const isHomeBattery = isHomeBatteryClassKey(device?.deviceClass);
  const supportsTemperature = supportsTemperatureDevice(device);
  const canControlTemperature = supportsTemperatureAdjustments(device);
  const supportsPower = supportsPowerDevice(device);
  const nativeWiringRequired = requiresNativeWiringForActivation(device);
  // A temperature device without power support is still managed for its mode
  // target and price shift; only power limiting waits for a reading. A home
  // battery listed here is one PELS can manage, unless its Managed map does not
  // parse: the runtime then treats it as unmanaged, and the switch shows off,
  // unavailable, until the value is repaired.
  const canManageDevice = isHomeBattery
    ? isBatteryControlReadable()
    : (supportsPower || supportsTemperature) && !nativeWiringRequired;
  return {
    isHomeBattery,
    supportsTemperature,
    canControlTemperature,
    supportsPower,
    canLimitPower: supportsPowerLimiting(device),
    canManageDevice,
    isManaged: canManageDevice && resolveManagedState(deviceId),
  };
};

// A price/surplus switch is on only for a managed temperature device, and is
// disabled (greyed) otherwise — the shared gate for both detail toggles.
export const setTemperatureGatedSwitch = (
  switchEl: { selected: boolean; disabled: boolean } | null,
  active: boolean | undefined,
  controlState: { supportsTemperature: boolean; canControlTemperature: boolean; isManaged: boolean },
): void => {
  if (!switchEl) return;
  /* eslint-disable no-param-reassign -- intentional DOM element mutation via a shared helper */
  switchEl.selected = controlState.canControlTemperature && controlState.isManaged && active === true;
  switchEl.disabled = !controlState.canControlTemperature || !controlState.isManaged;
  /* eslint-enable no-param-reassign */
};

/**
 * The Power-limit control switch. A battery reads `controllable_devices`
 * through its own gate (absent = on), and its switch is greyed out while
 * Managed is off or its Managed map does not parse (`isManaged` is false for
 * both): PELS then leaves the battery alone, so there is nothing to limit.
 */
export const setPowerLimitSwitch = (
  switchEl: { selected: boolean; disabled: boolean } | null,
  controlState: ReturnType<typeof resolveDeviceDetailControlState>,
  deviceId: string,
): void => {
  if (!switchEl) return;
  /* eslint-disable no-param-reassign -- intentional DOM element mutation via a shared helper */
  if (controlState.isHomeBattery) {
    switchEl.selected = resolveBatteryPowerLimitOn(deviceId);
    switchEl.disabled = !controlState.isManaged;
    return;
  }
  switchEl.selected = controlState.canLimitPower && state.controllableMap[deviceId] === true;
  switchEl.disabled = !controlState.canLimitPower || !controlState.isManaged;
  /* eslint-enable no-param-reassign */
};
