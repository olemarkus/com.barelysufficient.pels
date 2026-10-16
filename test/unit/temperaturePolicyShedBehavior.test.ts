import { describe, expect, it } from 'vitest';
import {
  resolveTemperaturePolicyShedBehavior,
  resolveTemperaturePolicyShedLimitsC,
} from '../../lib/device/temperatureControlPosture';
import { decoratedSnapshotFixture } from '../utils/deviceSnapshotFixture';

type PostureDevice = NonNullable<ReturnType<Parameters<typeof resolveTemperaturePolicyShedBehavior>[1]>>;

const noDevice = () => undefined;
const noModeTarget = () => null;
const withOnOff = (): PostureDevice => ({
  ...decoratedSnapshotFixture({
    available: true, id: 'ac', name: 'AC', targets: [], binaryControl: { on: true },
    expectedPowerKw: 1, expectedPowerSource: 'default',
  }),
  controlModel: 'binary_power',
  setpointShedFloorC: 10,
});
const steppedOnly = (): PostureDevice => ({
  ...decoratedSnapshotFixture({
    available: true, id: 'unit', name: 'Unit', targets: [],
    expectedPowerKw: 1, expectedPowerSource: 'default',
    steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 300 }] },
  }),
  controlModel: 'stepped_load',
  setpointShedFloorC: 10,
});
// A heat pump the setpoint alone can limit: no on/off this read, no steps.
const setpointOnly = (setpointC = 22, setpointShedFloorC = 10) => (): PostureDevice => ({
  ...decoratedSnapshotFixture({
    available: true, id: 'heatpump', name: 'Heat pump', expectedPowerKw: 1, expectedPowerSource: 'default',
    targets: [{ id: 'target_temperature', value: setpointC, unit: '°C' }],
  }),
  controlModel: 'temperature_target',
  setpointShedFloorC,
});
// The same device on a read where Homey reported its `onoff`.
const thermostatWithOnOff = (): PostureDevice => ({ ...setpointOnly()(), binaryControl: { on: true } });

const bothLimits = { action: 'set_temperature' as const, temperature: 16, coolingTemperature: 27 };

describe('resolveTemperaturePolicyShedBehavior', () => {
  it('picks the limit for the direction the device is moving demand in', () => {
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, noDevice, true, 'heating', noModeTarget))
      .toEqual({ action: 'set_temperature', temperature: 16 });
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, noDevice, true, 'cooling', noModeTarget))
      .toEqual({ action: 'set_temperature', temperature: 27 });
  });

  it('denies the setpoint arm when the policy forbids limiting, in either direction', () => {
    // Denial falls to the device's other axis: off if it has one, its lowest
    // step if it is stepped, off when it has neither to fall to.
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, withOnOff, false, 'heating', noModeTarget))
      .toEqual({ action: 'turn_off' });
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, steppedOnly, false, 'cooling', noModeTarget))
      .toEqual({ action: 'set_step' });
    expect(resolveTemperaturePolicyShedBehavior(bothLimits, noDevice, false, 'cooling', noModeTarget))
      .toEqual({ action: 'turn_off' });
  });

  it('passes the non-setpoint arms straight through', () => {
    expect(resolveTemperaturePolicyShedBehavior({ action: 'turn_off' }, noDevice, false, 'cooling', noModeTarget))
      .toEqual({ action: 'turn_off' });
    expect(resolveTemperaturePolicyShedBehavior({ action: 'set_step' }, noDevice, false, 'cooling', noModeTarget))
      .toEqual({ action: 'set_step' });
    expect(resolveTemperaturePolicyShedBehavior({ action: 'turn_off' }, thermostatWithOnOff, true, 'heating', noModeTarget))
      .toEqual({ action: 'turn_off' });
  });

  describe('a device the setpoint alone can limit', () => {
    it('limits a saved turn-off or step-down through the setpoint, from the mode target', () => {
      // Mode target 21 less the 3 °C default setback.
      for (const configured of [{ action: 'turn_off' as const }, { action: 'set_step' as const }]) {
        expect(resolveTemperaturePolicyShedBehavior(configured, setpointOnly(), true, 'heating', () => 21))
          .toEqual({ action: 'set_temperature', temperature: 18 });
      }
    });

    it('sets back from a fixed base, never the live setpoint, when the mode holds no target', () => {
      // While limited, the live setpoint is the limit PELS wrote; a setback from
      // it would fall every build. The 20 °C fallback base less 3 °C, at any setpoint.
      for (const setpointC of [22, 17, 14]) {
        expect(resolveTemperaturePolicyShedBehavior(
          { action: 'turn_off' }, setpointOnly(setpointC), true, 'heating', noModeTarget,
        )).toEqual({ action: 'set_temperature', temperature: 17 });
      }
    });

    it('gives the write fence the same limits the planner sheds to, either direction', () => {
      expect(resolveTemperaturePolicyShedLimitsC({ action: 'turn_off' }, setpointOnly(), () => 21)).toEqual([18, 28]);
      expect(resolveTemperaturePolicyShedLimitsC(
        { action: 'set_temperature', temperature: 5, coolingTemperature: 26 }, setpointOnly(), noModeTarget,
      )).toEqual([10, 26]);
      expect(resolveTemperaturePolicyShedLimitsC({ action: 'turn_off' }, thermostatWithOnOff, () => 21)).toEqual([]);
    });

    it('never goes below the device floor, saved or derived', () => {
      expect(resolveTemperaturePolicyShedBehavior(
        { action: 'set_temperature', temperature: 5, coolingTemperature: 28 }, setpointOnly(), true, 'heating', noModeTarget,
      )).toEqual({ action: 'set_temperature', temperature: 10 });
      expect(resolveTemperaturePolicyShedBehavior({ action: 'turn_off' }, setpointOnly(22, 16), true, 'heating', () => 17))
        .toEqual({ action: 'set_temperature', temperature: 16 });
    });

    it('uses the cooling limit while cooling', () => {
      expect(resolveTemperaturePolicyShedBehavior(bothLimits, setpointOnly(), true, 'cooling', noModeTarget))
        .toEqual({ action: 'set_temperature', temperature: 27 });
      expect(resolveTemperaturePolicyShedBehavior({ action: 'turn_off' }, setpointOnly(), true, 'cooling', noModeTarget))
        .toEqual({ action: 'set_temperature', temperature: 28 });
    });

    it('reads the saved choice again once the device reports on/off', () => {
      const saved = { action: 'turn_off' as const };
      expect(resolveTemperaturePolicyShedBehavior(saved, setpointOnly(), true, 'heating', () => 21).action)
        .toBe('set_temperature');
      expect(resolveTemperaturePolicyShedBehavior(saved, thermostatWithOnOff, true, 'heating', () => 21))
        .toEqual({ action: 'turn_off' });
    });
  });
});
