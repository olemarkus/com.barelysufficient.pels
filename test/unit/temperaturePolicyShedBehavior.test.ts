import { describe, expect, it } from 'vitest';
import { resolveTemperaturePolicyShedBehavior } from '../../lib/device/temperatureControlPosture';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';

const noDevice = () => undefined;
const withOnOff = (): DecoratedDeviceSnapshot => ({
  available: true, id: 'ac', name: 'AC', targets: [], binaryControl: { on: true },
  expectedPowerKw: 1, expectedPowerSource: 'default',
});
const steppedOnly = (): DecoratedDeviceSnapshot => ({
  available: true, id: 'unit', name: 'Unit', targets: [],
  expectedPowerKw: 1, expectedPowerSource: 'default',
  steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 300 }] },
});

const bothLimits = { action: 'set_temperature' as const, temperature: 16, coolingTemperature: 27 };

describe('resolveTemperaturePolicyShedBehavior', () => {
  it('picks the limit for the direction the device is moving demand in', () => {
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, noDevice, true, 'heating'))
      .toEqual({ action: 'set_temperature', temperature: 16 });
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, noDevice, true, 'cooling'))
      .toEqual({ action: 'set_temperature', temperature: 27 });
  });

  it('denies the setpoint arm when the policy forbids limiting, in either direction', () => {
    // Denial falls to the device's other axis: off if it has one, its lowest
    // step if it is stepped, off when it has neither to fall to.
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, withOnOff, false, 'heating'))
      .toEqual({ action: 'turn_off' });
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, steppedOnly, false, 'cooling'))
      .toEqual({ action: 'set_step' });
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, noDevice, false, 'cooling'))
      .toEqual({ action: 'turn_off' });
  });

  it('passes the non-setpoint arms straight through', () => {
    expect(resolveTemperaturePolicyShedBehavior({ action: 'turn_off' }, noDevice, false, 'cooling'))
      .toEqual({ action: 'turn_off' });
    expect(resolveTemperaturePolicyShedBehavior({ action: 'set_step' }, noDevice, false, 'cooling'))
      .toEqual({ action: 'set_step' });
  });
});
