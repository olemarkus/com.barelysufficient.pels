import { configuredShedTemperatures, getShedBehavior, normalizeShedBehaviors } from '../../lib/utils/capacityHelpers';

describe('capacityHelpers', () => {
  it('preserves set_step shed behavior when no step id is configured', () => {
    const behaviors = normalizeShedBehaviors({
      'dev-1': { action: 'set_step' },
    });

    expect(behaviors).toEqual({
      'dev-1': { action: 'set_step' },
    });
    // The accessor hands back the stored variant unchanged. A `set_step` arm
    // carries no payload at all: its floor is the device's lowest active step,
    // derived from the profile rather than configured here.
    expect(getShedBehavior('dev-1', behaviors)).toEqual({ action: 'set_step' });
  });

  it('drops legacy step ids for set_step during normalization', () => {
    const behaviors = normalizeShedBehaviors({
      'dev-1': { action: 'set_step', stepId: 'low' },
    });

    expect(behaviors).toEqual({
      'dev-1': { action: 'set_step' },
    });
  });

  it('keeps a configured cooling limit beside the heating one, clamped like it, and resolves a missing one', () => {
    // The two limits are one entry: a floor the device may fall to while
    // heating, a ceiling it may rise to while cooling. Neither is a direction
    // decision — that happens where the device's direction is known. An entry
    // persisted before the cooling limit existed, or carrying junk there, is
    // resolved at this read to the default, so no consumer asks whether one is set.
    const behaviors = normalizeShedBehaviors({
      'dev-1': { action: 'set_temperature', temperature: 16, coolingTemperature: 27 },
      'dev-2': { action: 'set_temperature', temperature: 16, coolingTemperature: 99 },
      'dev-3': { action: 'set_temperature', temperature: 16, coolingTemperature: 'warm' },
      'dev-4': { action: 'set_temperature', temperature: 16 },
    });

    expect(behaviors).toEqual({
      'dev-1': { action: 'set_temperature', temperature: 16, coolingTemperature: 27 },
      'dev-2': { action: 'set_temperature', temperature: 16, coolingTemperature: 50 },
      'dev-3': { action: 'set_temperature', temperature: 16, coolingTemperature: 28 },
      'dev-4': { action: 'set_temperature', temperature: 16, coolingTemperature: 28 },
    });
  });

  it('lists both configured limits for the write fence, or none for a non-setpoint shed', () => {
    const behaviors = normalizeShedBehaviors({
      heater: { action: 'set_temperature', temperature: 16 },
      ac: { action: 'set_temperature', temperature: 16, coolingTemperature: 27 },
      plug: { action: 'turn_off' },
    });
    expect(configuredShedTemperatures('heater', behaviors)).toEqual([16, 28]);
    expect(configuredShedTemperatures('ac', behaviors)).toEqual([16, 27]);
    expect(configuredShedTemperatures('plug', behaviors)).toEqual([]);
    expect(configuredShedTemperatures('unknown', behaviors)).toEqual([]);
  });
});
