import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';

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

type GrayStateDevice = {
  available?: boolean;
  currentState?: string;
  observationStale?: boolean;
};

export const isGrayStateDevice = (device?: GrayStateDevice | null): boolean => {
  if (!device) return false;
  if (device.available === false) return true;
  if (device.observationStale === true) return true;
  const currentState = typeof device.currentState === 'string' ? device.currentState.trim().toLowerCase() : '';
  return currentState === 'unknown' || currentState === 'disappeared';
};

export const requiresNativeWiringForActivation = (device?: TargetDeviceSnapshot | null): boolean => (
  device?.controlAdapter?.kind === 'capability_adapter'
  && device.controlAdapter.activationRequired === true
  && device.controlAdapter.activationEnabled !== true
  && device.controlCapabilityId !== 'evcharger_charging'
);

export const supportsNativeWiringActivation = (device?: TargetDeviceSnapshot | null): boolean => (
  device?.controlAdapter?.kind === 'capability_adapter'
  && (
    device.controlAdapter.activationRequired === true
    || device.controlAdapter.activationAvailable === true
  )
);
