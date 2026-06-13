import { shouldCelebrateFirstEstimate, toTemperatureDeviceOptions } from '../src/ui/weatherInsight.ts';

describe('toTemperatureDeviceOptions', () => {
  it('keeps only temperature-capable devices and sorts them by name', () => {
    const options = toTemperatureDeviceOptions([
      { id: 'evcharger', name: 'EV Charger', hasTemperature: false },
      { id: 'outdoor', name: 'Outdoor sensor', hasTemperature: true },
      { id: 'heatpump', name: 'Heat Pump', hasTemperature: true },
      { id: 'waterheater', name: 'Water Heater', hasTemperature: false },
    ]);
    expect(options).toEqual([
      { id: 'heatpump', label: 'Heat Pump' },
      { id: 'outdoor', label: 'Outdoor sensor' },
    ]);
  });

  it('treats a missing hasTemperature flag as not a temperature device', () => {
    // Defensive: a stale API without the field must not surface every device.
    expect(toTemperatureDeviceOptions([{ id: 'x', name: 'Legacy' }])).toEqual([]);
  });

  it('returns an empty list when nothing is temperature-capable', () => {
    expect(toTemperatureDeviceOptions([{ id: 'a', name: 'A', hasTemperature: false }])).toEqual([]);
  });
});

describe('shouldCelebrateFirstEstimate', () => {
  it('fires once on the first ready readout', () => {
    expect(shouldCelebrateFirstEstimate('ready', false)).toBe(true);
  });

  it('does not fire again once seen', () => {
    expect(shouldCelebrateFirstEstimate('ready', true)).toBe(false);
  });

  it('does not fire before the estimate is ready', () => {
    expect(shouldCelebrateFirstEstimate('learning', false)).toBe(false);
    expect(shouldCelebrateFirstEstimate('backfilling', false)).toBe(false);
    expect(shouldCelebrateFirstEstimate(undefined, false)).toBe(false);
  });
});
