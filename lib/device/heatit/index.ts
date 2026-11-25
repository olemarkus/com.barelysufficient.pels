import type { DeviceAdapter } from '../deviceAdapter';
import { readDeviceReportSettings } from '../deviceReportSettings';

const TRM3 = 'homey:app:no.thermofloor:z-trm3';
const TRM6_DC = 'homey:app:no.thermofloor:z-trm6-dc';
const DRIVER_IDS = new Set([TRM3, TRM6_DC, 'homey:app:no.thermofloor:z-trm6', 'homey:app:no.thermofloor:z-trm7']);
const SENSOR_MODES = new Map([['0', 'F'], ['1', 'A'], ['2', 'AF'], ['3', 'A2'], ['4', 'A2F'], ['5', 'PWER']]);

function sensorMode(value: unknown, hasPowerRegulator: boolean): { value: string } | undefined {
  if (typeof value !== 'string' || (value === '5' && !hasPowerRegulator)) return undefined;
  const mode = SENSOR_MODES.get(value);
  return mode === undefined ? undefined : { value: mode };
}

function floorMinimum(value: unknown): { value: number; unit: '°C' } | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 50 && value <= 400
    ? { value: value / 10, unit: '°C' } : undefined;
}

export const heatitSettingsAdapter: Pick<DeviceAdapter, 'matches' | 'reportSettings'> = {
  matches: (device) => DRIVER_IDS.has(device.driverId.toLowerCase()),
  reportSettings: (device) => {
    const driver = device.driverId.toLowerCase();
    if (driver === TRM3) {
      return readDeviceReportSettings(device.settings, {
        Sensor_mode: (value) => sensorMode(value, false),
        Floor_minimum_temperature_limit_FLo: floorMinimum,
      });
    }
    return readDeviceReportSettings(device.settings, {
      sensor_mode: (value) => sensorMode(value, driver !== TRM6_DC),
      floor_sensor_min_temp_limit: floorMinimum,
    });
  },
};
