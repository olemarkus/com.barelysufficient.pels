import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  requiresNativeWiringForActivation,
  supportsManagedDevice,
  supportsPowerDevice,
  supportsTemperatureDevice,
} from '../deviceUtils.ts';
import { resolveManagedState } from '../state.ts';

export const resolveDeviceDetailControlState = (
  device: TargetDeviceSnapshot | null,
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
