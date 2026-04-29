import { describe, expect, it } from 'vitest';
import { buildExecutablePlan, buildExecutablePlanDevice } from '../lib/plan/planExecutablePlan';
import { buildExecutableTargetUpdate } from '../lib/plan/planExecutableTarget';
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
  it('projects stepped-load actions once at the executor boundary', () => {
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

    expect(executablePlan.devices).toEqual([
      { planDevice: steppedDevice },
      { planDevice: binaryDevice },
    ]);

    expect(buildExecutablePlanDevice(steppedDevice)).toMatchObject({
      planDevice: steppedDevice,
      steppedLoad: {
        id: 'step-1',
        requestedStepId: 'max',
        currentStepId: 'low',
      },
    });
    expect(buildExecutablePlanDevice(binaryDevice)).toEqual({
      planDevice: binaryDevice,
      steppedLoad: null,
    });
  });

  it('projects target updates into the executor-facing command shape', () => {
    const thermostat = buildPlanDevice({
      id: 'thermostat-1',
      name: 'Thermostat',
      currentTarget: 16,
      plannedTarget: 21,
    });

    expect(buildExecutableTargetUpdate(
      thermostat,
      {
        id: 'thermostat-1',
        name: 'Thermostat',
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 16 }],
      },
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

  it('uses the current snapshot fallback when projecting target updates', () => {
    const thermostat = buildPlanDevice({
      id: 'thermostat-1',
      name: 'Thermostat',
      currentTarget: 18,
      plannedTarget: 20,
    });

    expect(buildExecutableTargetUpdate(
      thermostat,
      undefined,
      () => ({ action: 'turn_off', temperature: null, stepId: null }),
      () => ({
        id: 'thermostat-1',
        name: 'Thermostat',
        currentOn: true,
        targets: [{ id: 'target_temperature', value: 18 }],
      }),
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
