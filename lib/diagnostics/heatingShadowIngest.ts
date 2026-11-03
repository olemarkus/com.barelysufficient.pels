import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { HeatingShadowDevice, HeatingShadowReading } from './heatingShadowTypes';
import type { ThermalDirection } from '../../packages/contracts/src/types';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';

function observedControl(device: DeviceSurfaces): HeatingShadowReading['control'] {
  if (device.binaryControl?.on === false) return 'disabled';
  return device.binaryControl?.on === true ? 'enabled' : 'unobserved';
}

/**
 * The managed heating devices with a temperature and directly reported power,
 * as accepted observations held at this meter sample.
 */
export function observeHeatingShadowDevices(
  devices: readonly DeviceSurfaces[],
  nowMs: number,
  getThermalDirection: (deviceId: string) => ThermalDirection,
): HeatingShadowDevice[] {
  return devices.flatMap((device): HeatingShadowDevice[] => {
    if (!device.managed || device.available === false || !isTemperatureControlDevice(device)
      || !hasObservedTemperature(device) || !hasObservedMeasuredPower(device)
      || !device.measuredPowerIsDirectMeasurement || getThermalDirection(device.id) !== 'heating') return [];
    return [{ id: device.id,
      signal: { temperatureCapability: 'measure_temperature', temperatureRole: 'unclassified',
        targetCapability: device.temperature.target.id, electricalInput: 'held_reported_direct_power' },
      reading: { atMs: nowMs, temperatureC: device.temperature.currentTemperature,
        powerKw: device.measuredPowerKw, targetC: device.temperature.target.value,
        control: observedControl(device) } }];
  });
}
