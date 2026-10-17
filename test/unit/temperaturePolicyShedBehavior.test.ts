import { describe, expect, it, vi } from 'vitest';
import {
  resolveTemperaturePolicyShedBehavior,
  resolveTemperaturePolicyShedLimitsC,
} from '../../lib/device/temperatureControlPosture';
import { decoratedSnapshotFixture } from '../utils/deviceSnapshotFixture';
import { captureLogger } from '../utils/loggerCapture';

type PostureDevice = NonNullable<ReturnType<Parameters<typeof resolveTemperaturePolicyShedBehavior>[2]>>;

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
// The same device with its temperature measured this read: eligible for a setpoint limit.
const measuredThermostat = (): PostureDevice => {
  const device = thermostatWithOnOff();
  const [target] = device.targets;
  return { ...device, temperature: { currentTemperature: 21, target: target! } } as PostureDevice;
};

// The stored configuration is the device's own, as the caller passes it.
type Args = Parameters<typeof resolveTemperaturePolicyShedBehavior>;
const shed = (configured: Args[0], readDevice: Args[2], allowsLimiting: Args[3], direction: Args[4], readModeTargetC: Args[5]) => (
  resolveTemperaturePolicyShedBehavior(configured, readDevice(), readDevice, allowsLimiting, direction, readModeTargetC)
);
const shedLimits = (configured: Args[0], readDevice: Args[2], readModeTargetC: Args[5]) => (
  resolveTemperaturePolicyShedLimitsC(configured, readDevice(), readDevice, readModeTargetC)
);

const bothLimits = { action: 'set_temperature' as const, temperature: 16, coolingTemperature: 27 };

describe('resolveTemperaturePolicyShedBehavior', () => {
  it('picks the limit for the direction the device is moving demand in', () => {
    expect(shed(bothLimits, measuredThermostat, true, 'heating', noModeTarget))
      .toEqual({ action: 'set_temperature', temperature: 16 });
    expect(shed(bothLimits, measuredThermostat, true, 'cooling', noModeTarget))
      .toEqual({ action: 'set_temperature', temperature: 27 });
  });

  // Owner ruling 2026-10-17: a device without `measure_temperature` this read is
  // not eligible for a setpoint limit, so a saved one resolves to its other axis.
  it('turns off a device saved as "set temperature" while it reports no temperature, and logs the change once', () => {
    // Start from an eligible read, so what earlier tests left noted does not matter.
    shed(bothLimits, measuredThermostat, true, 'heating', noModeTarget);
    const logs = captureLogger('info');
    try {
      expect(shed(bothLimits, thermostatWithOnOff, true, 'heating', noModeTarget)).toEqual({ action: 'turn_off' });
      expect(shed(bothLimits, thermostatWithOnOff, true, 'heating', noModeTarget)).toEqual({ action: 'turn_off' });
      expect(logs.findEvents('shed_setpoint_limit_unavailable')).toEqual([
        expect.objectContaining({ deviceId: 'heatpump', reasonCode: 'no_measured_temperature', resolvedAction: 'turn_off' }),
      ]);

      expect(shed(bothLimits, measuredThermostat, true, 'heating', noModeTarget))
        .toEqual({ action: 'set_temperature', temperature: 16 });
      expect(logs.findEvents('shed_setpoint_limit_available')).toHaveLength(1);
      expect(shedLimits(bothLimits, thermostatWithOnOff, noModeTarget)).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it('steps a stepped device saved as "set temperature" down while it reports no temperature', () => {
    expect(shed(bothLimits, steppedOnly, true, 'heating', noModeTarget)).toEqual({ action: 'set_step' });
  });

  it('denies the setpoint arm when the policy forbids limiting, in either direction', () => {
    // Denial falls to the device's other axis: off if it has one, its lowest
    // step if it is stepped, off when it has neither to fall to.
    expect(shed(bothLimits, withOnOff, false, 'heating', noModeTarget))
      .toEqual({ action: 'turn_off' });
    expect(shed(bothLimits, steppedOnly, false, 'cooling', noModeTarget))
      .toEqual({ action: 'set_step' });
    expect(shed(bothLimits, noDevice, false, 'cooling', noModeTarget))
      .toEqual({ action: 'turn_off' });
  });

  it('passes the non-setpoint arms straight through', () => {
    expect(shed({ action: 'turn_off' }, noDevice, false, 'cooling', noModeTarget))
      .toEqual({ action: 'turn_off' });
    expect(shed({ action: 'set_step' }, noDevice, false, 'cooling', noModeTarget))
      .toEqual({ action: 'set_step' });
    expect(shed({ action: 'turn_off' }, thermostatWithOnOff, true, 'heating', noModeTarget))
      .toEqual({ action: 'turn_off' });
  });

  describe('a device the setpoint alone can limit', () => {
    it('limits a saved turn-off or step-down through the setpoint, from the mode target', () => {
      // Mode target 21 less the 3 °C default setback.
      for (const configured of [{ action: 'turn_off' as const }, { action: 'set_step' as const }]) {
        expect(shed(configured, setpointOnly(), true, 'heating', () => 21))
          .toEqual({ action: 'set_temperature', temperature: 18 });
      }
    });

    it('sets back from a fixed base, never the live setpoint, when the mode holds no target', () => {
      // While limited, the live setpoint is the limit PELS wrote; a setback from
      // it would fall every build. The 20 °C fallback base less 3 °C, at any setpoint.
      for (const setpointC of [22, 17, 14]) {
        expect(shed(
          { action: 'turn_off' }, setpointOnly(setpointC), true, 'heating', noModeTarget,
        )).toEqual({ action: 'set_temperature', temperature: 17 });
      }
    });

    it('gives the write fence the same limits the planner sheds to, either direction', () => {
      expect(shedLimits({ action: 'turn_off' }, setpointOnly(), () => 21)).toEqual([18, 28]);
      expect(shedLimits(
        { action: 'set_temperature', temperature: 5, coolingTemperature: 26 }, setpointOnly(), noModeTarget,
      )).toEqual([10, 26]);
      expect(shedLimits({ action: 'turn_off' }, thermostatWithOnOff, () => 21)).toEqual([]);
    });

    it('never goes below the device floor, saved or derived', () => {
      expect(shed(
        { action: 'set_temperature', temperature: 5, coolingTemperature: 28 }, setpointOnly(), true, 'heating', noModeTarget,
      )).toEqual({ action: 'set_temperature', temperature: 10 });
      expect(shed({ action: 'turn_off' }, setpointOnly(22, 16), true, 'heating', () => 17))
        .toEqual({ action: 'set_temperature', temperature: 16 });
    });

    it('uses the cooling limit while cooling', () => {
      expect(shed(bothLimits, setpointOnly(), true, 'cooling', noModeTarget))
        .toEqual({ action: 'set_temperature', temperature: 27 });
      expect(shed({ action: 'turn_off' }, setpointOnly(), true, 'cooling', noModeTarget))
        .toEqual({ action: 'set_temperature', temperature: 28 });
    });

    it('reads the saved choice again once the device reports on/off', () => {
      const saved = { action: 'turn_off' as const };
      expect(shed(saved, setpointOnly(), true, 'heating', () => 21).action)
        .toBe('set_temperature');
      expect(shed(saved, thermostatWithOnOff, true, 'heating', () => 21))
        .toEqual({ action: 'turn_off' });
    });
  });

  it('reads the device only when the answer needs it', () => {
    const readDevice = vi.fn(withOnOff);
    expect(resolveTemperaturePolicyShedBehavior(
      { action: 'turn_off' }, { controlModel: 'binary_power' }, readDevice, true, 'heating', noModeTarget,
    )).toEqual({ action: 'turn_off' });
    expect(resolveTemperaturePolicyShedBehavior(
      { action: 'turn_off' }, undefined, readDevice, false, 'heating', noModeTarget,
    )).toEqual({ action: 'turn_off' });
    expect(readDevice).not.toHaveBeenCalled();

    const readSetpointOnly = vi.fn(setpointOnly());
    expect(resolveTemperaturePolicyShedLimitsC(
      { action: 'turn_off' }, { controlModel: 'temperature_target' }, readSetpointOnly, () => 21,
    )).toEqual([18, 28]);
    expect(readSetpointOnly).toHaveBeenCalledTimes(1);
  });
});
