import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

// A device supports a temperature smart task if it reports a temperature device type or any
// settable target (thermostats, water heaters, etc.).
export const supportsTemperatureObjective = (device: TargetDeviceSnapshot): boolean => (
  device.deviceType === 'temperature' || device.targets.length > 0
);

export const isEvCharger = (device: TargetDeviceSnapshot): boolean => (
  device.deviceClass === 'evcharger'
);

// A device can carry a smart task — and therefore a rescue permission — when it is
// temperature-deadline-capable or an EV charger. Used to populate device dropdowns by
// capability rather than by whichever tasks happen to exist at flow-build time.
export const supportsSmartTaskObjective = (device: TargetDeviceSnapshot): boolean => (
  supportsTemperatureObjective(device) || isEvCharger(device)
);
