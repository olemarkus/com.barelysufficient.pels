import { listModeTargetFillDevices } from '../../setup/appDeviceSupport';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { TemperatureDiscriminantProbe } from '../../lib/plan/planTypes';
import { buildPlanInputDevice, fixtureControlPosture } from '../utils/planTestUtils';

describe('listModeTargetFillDevices', () => {
  // PLAN devices, because that is what the projection takes: the control
  // projection has already run, so a device whose owner switched temperature
  // control off arrives here as a plain non-temperature device and this fixture
  // cannot express the flag at all. The fill itself is
  // `lib/home/modeDeviceTargetFill.ts` (`modeDeviceTargetFill.test.ts`).
  const thermostatDefaults = {
    id: 't-1',
    name: 'Stue',
    deviceType: 'temperature' as const,
    currentTarget: 21,
    currentTemperature: 21,
    targets: [{ id: 'target_temperature', value: 21, unit: '°C', min: 5, max: 35, step: 0.5 }],
    currentDrawKw: 1,
  };
  const buildThermostat = (
    overrides: Partial<PlanInputDevice> & TemperatureDiscriminantProbe = {},
  ): PlanInputDevice => buildPlanInputDevice({ ...thermostatDefaults, ...overrides });
  const buildUnmeteredThermostat = (): PlanInputDevice => (
    buildPlanInputDevice({ ...thermostatDefaults, unmetered: true })
  );

  it('lists a planned thermostat with the setpoint PELS holds it at', () => {
    expect(listModeTargetFillDevices([buildThermostat()]))
      .toEqual([{ id: 't-1', name: 'Stue', heldSetpointC: 21 }]);
  });

  it('lists a thermostat without a per-device reading, since the plan still sets its mode target', () => {
    expect(listModeTargetFillDevices([buildUnmeteredThermostat()]))
      .toEqual([{ id: 't-1', name: 'Stue', heldSetpointC: 21 }]);
  });

  it('normalizes the held setpoint through the target capability bounds and step', () => {
    // Capability step=0.5, min=5, max=35; raw current 21.34 should snap to 21.5
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: 21.34, unit: '°C', min: 5, max: 35, step: 0.5 }],
    });

    expect(listModeTargetFillDevices([thermostat]))
      .toEqual([{ id: 't-1', name: 'Stue', heldSetpointC: 21.5 }]);
  });

  it('lists no device with no usable setpoint', () => {
    const thermostat = buildThermostat({
      targets: [{ id: 'target_temperature', value: Number.NaN, unit: '°C' }],
    });

    expect(listModeTargetFillDevices([thermostat])).toEqual([]);
  });

  it('lists no device whose temperature control is off', () => {
    // The projection has no concept of the flag. `toPlanDevice` resolved it
    // away, so the device reaches here as a plain non-temperature device — the
    // SAME shape as an on/off load, which is the point: one predicate covers
    // both reasons a device has no setpoint.
    expect(listModeTargetFillDevices([buildThermostat({ deviceType: 'onoff', targets: [] })])).toEqual([]);
  });

  it('ignores a device the planner does not plan and one with no setpoint', () => {
    // `control.managed` is the planner's own answer: `managed_devices` resolved
    // per device, where a device with no entry is not managed. Filling a target
    // for it would seed a setpoint PELS does not hold.
    expect(listModeTargetFillDevices([
      buildThermostat({ id: 't-unmanaged', control: fixtureControlPosture({ managed: false }) }),
      buildThermostat({ id: 't-notemp', deviceType: 'onoff', targets: [] }),
    ])).toEqual([]);
  });

  it('lists a device whose capacity control is off', () => {
    // A metered thermostat remains eligible for mode-target filling even when
    // its power-limit switch is off. That switch governs shedding; it does not
    // remove the temperature target axis.
    expect(listModeTargetFillDevices([buildThermostat({ control: fixtureControlPosture({ controllable: false }) })]))
      .toEqual([{ id: 't-1', name: 'Stue', heldSetpointC: 21 }]);
  });
});
