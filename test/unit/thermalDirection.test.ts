import { describe, it, expect } from 'vitest';
import { resolveThermalDirection } from '../../lib/observer/thermalDirection';

describe('resolveThermalDirection', () => {
  it('resolves heating for a device that reports no mode at all', () => {
    // A water heater, a panel radiator, anything with no mode axis — and the
    // behaviour every device had before the direction existed.
    expect(resolveThermalDirection({})).toBe('heating');
    expect(resolveThermalDirection({ thermostatMode: undefined })).toBe('heating');
  });

  it.each(['cool', 'cooling'])('resolves cooling for %j', (thermostatMode) => {
    // Homey's own enum spells it one way; driver-supplied option lists (Daikin's
    // ONECTA) spell it the other. Admitting one would mis-direct the other's fleet.
    expect(resolveThermalDirection({ thermostatMode })).toBe('cooling');
  });

  it.each(['heat', 'heating', 'auto', 'off', 'dry', 'fan', 'fan_only'])(
    'resolves heating for the known non-cooling mode %j',
    (thermostatMode) => {
      expect(resolveThermalDirection({ thermostatMode })).toBe('heating');
    },
  );

  it('resolves heating for a mode it cannot name', () => {
    // `'cooling'` only on positive evidence. A driver-specific word is not that,
    // and inventing a direction from it would be worse than the default.
    expect(resolveThermalDirection({ thermostatMode: 'turbo_boost' })).toBe('heating');
  });
});
