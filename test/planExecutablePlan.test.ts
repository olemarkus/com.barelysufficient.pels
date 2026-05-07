import { describe, expect, it } from 'vitest';
import {
  buildExecutableObservedDeviceState,
  buildExecutablePlan,
} from '../lib/executor/executablePlanProjection';
import {
  buildExecutableTargetIntent,
  buildExecutableTargetUpdate,
} from '../lib/executor/executableTargetProjection';
import type { DevicePlan } from '../lib/plan/planTypes';
import { buildPlanDevice, steppedPlanDevice } from './utils/planTestUtils';

const planWithDevices = (devices: DevicePlan['devices']): DevicePlan => ({
  meta: {
    totalKw: 1,
    softLimitKw: 5,
    headroomKw: 4,
  },
  devices,
});

describe('planExecutablePlan', () => {
  it('projects executable plan devices as intent, not planner-device wrappers', () => {
    const steppedDevice = steppedPlanDevice({
      id: 'step-1',
      selectedStepId: 'low',
      desiredStepId: 'max',
      reportedStepId: 'low',
    });
    const binaryDevice = buildPlanDevice({
      id: 'binary-1',
      controlModel: 'binary_power',
    });

    const executablePlan = buildExecutablePlan(planWithDevices([steppedDevice, binaryDevice]));

    expect(executablePlan.devices).toHaveLength(2);
    expect(executablePlan.devices[0]).toMatchObject({
      id: 'step-1',
      name: steppedDevice.name,
      controllable: true,
      binary: null,
      steppedLoad: {
        id: 'step-1',
        desired: {
          stepId: 'max',
        },
      },
    });
    expect(executablePlan.devices[0]).not.toHaveProperty('planDevice');
    expect(executablePlan.devices[0]?.steppedLoad).not.toHaveProperty('current');
    expect(executablePlan.devices[1]).toMatchObject({
      id: 'binary-1',
      steppedLoad: null,
      binary: {
        kind: 'restore',
        source: 'controlled',
      },
    });
  });

  it('projects target updates into the executor-facing command shape', () => {
    const thermostat = buildPlanDevice({
      id: 'thermostat-1',
      name: 'Thermostat',
      currentTarget: 16,
      plannedTarget: 21,
    });
    const intent = buildExecutableTargetIntent(thermostat);
    const observed = buildExecutableObservedDeviceState({
      id: 'thermostat-1',
      name: 'Thermostat',
      currentOn: true,
      targets: [{ id: 'target_temperature', value: 16 }],
    });

    expect(buildExecutableTargetUpdate(
      intent,
      observed,
      () => ({ action: 'set_temperature', temperature: 16, stepId: null }),
    )).toEqual({
      deviceId: 'thermostat-1',
      name: 'Thermostat',
      targetCap: 'target_temperature',
      desired: 21,
      observedValue: 16,
      isRestoring: true,
    });
  });

  it('uses observed state when projecting target updates', () => {
    const thermostat = buildPlanDevice({
      id: 'thermostat-1',
      name: 'Thermostat',
      currentTarget: 18,
      plannedTarget: 20,
    });
    const intent = buildExecutableTargetIntent(thermostat);
    const observed = buildExecutableObservedDeviceState({
      id: 'thermostat-1',
      name: 'Thermostat',
      currentOn: true,
      targets: [{ id: 'target_temperature', value: 18 }],
    });

    expect(buildExecutableTargetUpdate(
      intent,
      observed,
      () => ({ action: 'turn_off', temperature: null, stepId: null }),
    )).toEqual({
      deviceId: 'thermostat-1',
      name: 'Thermostat',
      targetCap: 'target_temperature',
      desired: 20,
      observedValue: 18,
      isRestoring: false,
    });
  });
});
