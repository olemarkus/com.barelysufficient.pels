import type { DecoratedDeviceSnapshot } from '../packages/contracts/src/types';
import { supportsSmartTaskKind } from '../packages/shared-domain/src/smartTaskDeviceKind';

// A device supports a temperature smart task if it reports a temperature device type or any
// settable target (thermostats, water heaters, etc.).
export const supportsTemperatureObjective = (device: DecoratedDeviceSnapshot): boolean => (
  device.temperatureControlDisabled !== true
  && device.temperatureAdjustmentsDisabled !== true
  && (device.deviceType === 'temperature' || device.targets.length > 0)
);

export const isEvCharger = (device: DecoratedDeviceSnapshot): boolean => (
  device.deviceClass === 'evcharger'
);

// A pure on/off device with a live power reading (a relay switching a water
// heater): the shared gate every creation path asks.
export const supportsEnergyObjective = (device: DecoratedDeviceSnapshot): boolean => (
  supportsSmartTaskKind(device, 'energy')
);

// A device can carry a smart task — and therefore a rescue permission — when it is
// temperature-deadline-capable, an EV charger, or a metered on/off device. Used to
// populate device dropdowns by capability rather than by whichever tasks happen to
// exist at flow-build time.
export const supportsSmartTaskObjective = (device: DecoratedDeviceSnapshot): boolean => (
  supportsTemperatureObjective(device) || isEvCharger(device) || supportsEnergyObjective(device)
);
