type SettingValue =
  | { value: number; unit: 'W' | 'A' | '°C' }
  | { value: boolean | string };

export type DeviceReportSettings = Record<string, SettingValue | { state: 'invalid' }>;

/** Select installed values using fixed keys and value readers. Null is unset. */
export function readDeviceReportSettings(
  settings: Readonly<Record<string, unknown>>,
  readers: Readonly<Record<string, (value: unknown) => SettingValue | undefined>>,
): DeviceReportSettings {
  return Object.fromEntries(Object.entries(readers).flatMap(([key, read]) => {
    if (!Object.hasOwn(settings, key)) return [];
    const value = settings[key];
    return value === null ? [] : [[key, read(value) ?? { state: 'invalid' }]];
  }));
}

const watts = (value: unknown): SettingValue | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? { value, unit: 'W' } : undefined
);

const ENERGY_SETTINGS = { load: watts, energy_value_on: watts, energy_value_off: watts };

/** Common Homey energy settings apply independently of the device integration. */
export const readHomeyEnergyReportSettings = (settings: Readonly<Record<string, unknown>>): DeviceReportSettings => (
  readDeviceReportSettings(settings, ENERGY_SETTINGS)
);
