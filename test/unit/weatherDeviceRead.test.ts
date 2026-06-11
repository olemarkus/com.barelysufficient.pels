import { readDeviceTemperature } from '../../lib/weather/weatherDeviceRead';

// Shaped like the real yr.no `myr` driver payload: the bare capability sits
// alongside `measure_temperature.*` sub-capabilities that carry different
// values and must never be picked up.
const yrWeatherDevice = (overrides: Record<string, unknown> = {}) => ({
  id: 'yr-1',
  name: 'Weather',
  capabilitiesObj: {
    'measure_temperature': { value: 3.4, lastUpdated: '2026-01-10T11:45:00.000Z' },
    'measure_temperature.feels_like': { value: -2.1 },
    'measure_temperature.min_next_6_hours': { value: -4 },
    'measure_temperature.max_next_6_hours': { value: 5 },
  },
  ...overrides,
});

describe('readDeviceTemperature', () => {
  it('reads the bare measure_temperature capability, not sub-capabilities', () => {
    expect(readDeviceTemperature(yrWeatherDevice())).toBe(3.4);
  });

  it('returns undefined when the capability is absent', () => {
    const device = yrWeatherDevice({
      capabilitiesObj: { 'measure_temperature.feels_like': { value: -2.1 } },
    });
    expect(readDeviceTemperature(device)).toBeUndefined();
  });

  it('rejects non-numeric and physically implausible values', () => {
    for (const value of ['3.4', Number.NaN, -80, 75]) {
      const device = yrWeatherDevice({ capabilitiesObj: { measure_temperature: { value } } });
      expect(readDeviceTemperature(device)).toBeUndefined();
    }
  });

  it('returns undefined when capabilitiesObj is missing entirely', () => {
    expect(readDeviceTemperature({ id: 'x', name: 'y' })).toBeUndefined();
  });
});
