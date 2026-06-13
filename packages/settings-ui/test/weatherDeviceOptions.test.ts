import { toTemperatureDeviceOptions } from '../src/ui/weatherInsight.ts';

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
