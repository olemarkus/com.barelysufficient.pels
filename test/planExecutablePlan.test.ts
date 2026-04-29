import { describe, expect, it } from 'vitest';
import { buildExecutablePlan, buildExecutablePlanDevice } from '../lib/plan/planExecutablePlan';
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
});
