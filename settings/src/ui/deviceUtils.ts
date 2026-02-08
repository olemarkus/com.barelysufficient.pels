import type { TargetDeviceSnapshot } from '../../../lib/utils/types';

export const supportsPowerDevice = (device?: TargetDeviceSnapshot | null): boolean => {
  if (!device) return false;
  if (device.powerCapable !== undefined) return device.powerCapable;
  return typeof device.powerKw === 'number'
    || typeof device.expectedPowerKw === 'number'
    || typeof device.measuredPowerKw === 'number'
    || typeof device.loadKw === 'number';
};

export const supportsTemperatureDevice = (device?: TargetDeviceSnapshot | null): boolean => {
  if (!device) return false;
  if (device.deviceType) return device.deviceType === 'temperature';
  return (device.targets?.length ?? 0) > 0;
};

export const supportsManagedDevice = (supportsPower: boolean, supportsTemperature: boolean): boolean => (
  supportsPower || supportsTemperature
);
