import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg } from '../flowCards/deviceArgs';

describe('flow card device helpers', () => {
  it('resolves identity from id fields only', () => {
    expect(getDeviceIdFromFlowArg('dev-1')).toBe('dev-1');
    expect(getDeviceIdFromFlowArg({ id: 'dev-2', name: 'Kitchen Heater' })).toBe('dev-2');
    expect(getDeviceIdFromFlowArg({ data: { id: 'dev-3' }, name: 'Hall Heater' })).toBe('dev-3');
    expect(getDeviceIdFromFlowArg({ name: 'Name Only' })).toBe('');
  });

  it('matches autocomplete queries by name or id', () => {
    const options = buildDeviceAutocompleteOptions([
      { id: 'heater-living-room', name: 'Living Room Heater' },
      { id: 'heater-bedroom', name: 'Bedroom Heater' },
    ], 'living-room');

    expect(options).toEqual([{ id: 'heater-living-room', name: 'Living Room Heater' }]);
  });

  it('disambiguates duplicate names with ids in labels', () => {
    const options = buildDeviceAutocompleteOptions([
      { id: 'heater-1', name: 'Heater' },
      { id: 'heater-2', name: 'Heater' },
      { id: 'ac-1', name: 'Air Conditioner' },
    ], '');

    expect(options).toEqual([
      { id: 'ac-1', name: 'Air Conditioner' },
      { id: 'heater-1', name: 'Heater (heater-1)' },
      { id: 'heater-2', name: 'Heater (heater-2)' },
    ]);
  });

  it('treats non-string autocomplete queries as empty queries', () => {
    const options = buildDeviceAutocompleteOptions([
      { id: 'heater-1', name: 'Heater' },
      { id: 'ac-1', name: 'Air Conditioner' },
    ], undefined);

    expect(options).toEqual([
      { id: 'ac-1', name: 'Air Conditioner' },
      { id: 'heater-1', name: 'Heater' },
    ]);
  });
});
