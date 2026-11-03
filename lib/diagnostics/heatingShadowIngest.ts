import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { HeatingShadowDevice, HeatingShadowReading } from '../../packages/contracts/src/heatingShadow';
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import type { ThermalDirection } from '../../packages/contracts/src/types';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import { incPerfCounter } from '../utils/perfCounters';
import { recordHeatingShadow } from './heatingShadow';

function observedControl(device: DeviceSurfaces): HeatingShadowReading['control'] {
  if (device.binaryControl?.on === false) return 'disabled';
  return device.binaryControl?.on === true ? 'enabled' : 'unobserved';
}

/** Passive evidence from the same accepted snapshot as meter ingest; no model or control updates. */
export function recordHeatingShadowFromSnapshot(
  state: PowerTrackerState,
  devices: readonly DeviceSurfaces[],
  nowMs: number,
  outdoorTemperatureC: number | undefined,
  getThermalDirection: (deviceId: string) => ThermalDirection,
  timeZone: string,
): PowerTrackerState {
  try {
    const observed = devices.flatMap((device): HeatingShadowDevice[] => {
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
    if (observed.length === 0 && !state.heatingShadow) return state;
    return { ...state, heatingShadow: recordHeatingShadow(state.heatingShadow, observed,
      nowMs, outdoorTemperatureC, timeZone) };
  } catch {
    // Evidence collection cannot interrupt billing, normal learning or planning.
    incPerfCounter('heating_shadow_collection_failed_total');
    return state;
  }
}
