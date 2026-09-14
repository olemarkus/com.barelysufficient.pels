import { describe, expect, it } from 'vitest';
import {
  isShedBehaviorsSetting,
  readShedBehaviors,
  resolveShedBehavior,
  shedLimitTemperatures,
} from '../../packages/shared-domain/src/settings/shedBehaviors';

describe('overshoot_behaviors read policy', () => {
  it('reads set_step as a bare action, dropping a legacy step id', () => {
    // A `set_step` arm carries no payload: its floor is the device's lowest
    // active step, derived from the profile rather than configured here.
    expect(readShedBehaviors({ 'dev-1': { action: 'set_step', stepId: 'low' } })).toEqual({
      'dev-1': { action: 'set_step' },
    });
  });

  it('clamps each limit into its own range and gives an entry without a cooling limit the default', () => {
    // One entry, two limits: a floor the device may fall to while heating, a
    // ceiling it may rise to while cooling. An entry saved before the cooling
    // limit existed, or carrying junk there, reads as the default, so no
    // consumer asks whether one is set.
    expect(readShedBehaviors({
      'dev-1': { action: 'set_temperature', temperature: 16, coolingTemperature: 27 },
      'dev-2': { action: 'set_temperature', temperature: -40, coolingTemperature: 99 },
      'dev-3': { action: 'set_temperature', temperature: 60, coolingTemperature: 'warm' },
      'dev-4': { action: 'set_temperature', temperature: 16 },
    })).toEqual({
      'dev-1': { action: 'set_temperature', temperature: 16, coolingTemperature: 27 },
      'dev-2': { action: 'set_temperature', temperature: -20, coolingTemperature: 40 },
      'dev-3': { action: 'set_temperature', temperature: 50, coolingTemperature: 28 },
      'dev-4': { action: 'set_temperature', temperature: 16, coolingTemperature: 28 },
    });
  });

  it('reads a setpoint entry with no usable heating limit as turn_off, and drops an entry that is not an object', () => {
    expect(readShedBehaviors({
      broken: { action: 'set_temperature', temperature: 'cold' },
      junk: 'turn_off',
    })).toEqual({ broken: { action: 'turn_off' } });
  });

  it('refuses a read that is not the map, so a caller keeps the one it holds', () => {
    expect(isShedBehaviorsSetting({})).toBe(true);
    expect(isShedBehaviorsSetting(null)).toBe(false);
    expect(isShedBehaviorsSetting([])).toBe(false);
  });

  it('answers turn_off for a device with no entry, including one named like a prototype member', () => {
    const behaviors = readShedBehaviors({ plug: { action: 'set_step' } });
    expect(resolveShedBehavior(behaviors, 'unknown')).toEqual({ action: 'turn_off' });
    expect(resolveShedBehavior(behaviors, 'toString')).toEqual({ action: 'turn_off' });
  });

  it('lists both limits for the write fence, or none for a shed that is not a setpoint', () => {
    const behaviors = readShedBehaviors({
      heater: { action: 'set_temperature', temperature: 16 },
      ac: { action: 'set_temperature', temperature: 16, coolingTemperature: 27 },
      plug: { action: 'turn_off' },
    });
    expect(shedLimitTemperatures(resolveShedBehavior(behaviors, 'heater'))).toEqual([16, 28]);
    expect(shedLimitTemperatures(resolveShedBehavior(behaviors, 'ac'))).toEqual([16, 27]);
    expect(shedLimitTemperatures(resolveShedBehavior(behaviors, 'plug'))).toEqual([]);
    expect(shedLimitTemperatures(resolveShedBehavior(behaviors, 'unknown'))).toEqual([]);
  });
});
