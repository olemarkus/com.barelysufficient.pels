import { describe, expect, it } from 'vitest';
import { buildExecutableObservedDeviceState } from '../lib/executor/executablePlanProjection';
import {
  buildExecutableSteppedLoadDevice,
  buildExecutableSteppedLoadIntent,
} from '../lib/executor/executableSteppedLoadProjection';
import type { DevicePlanDevice } from '../lib/plan/planTypes';
import type { TargetDeviceSnapshot } from '../lib/utils/types';
import { steppedPlanDevice } from './utils/planTestUtils';

const buildObservedState = (
  device: DevicePlanDevice,
  overrides: Partial<TargetDeviceSnapshot> = {},
) => buildExecutableObservedDeviceState({
  id: device.id,
  name: device.name,
  currentOn: device.currentOn ?? device.currentState === 'on',
  targets: [],
  controlModel: device.controlModel,
  steppedLoadProfile: device.steppedLoadProfile,
  selectedStepId: device.selectedStepId,
  reportedStepId: device.reportedStepId,
  actualStepId: device.actualStepId,
  actualStepSource: device.actualStepSource,
  assumedStepId: device.assumedStepId,
  measuredPowerKw: device.measuredPowerKw,
  ...overrides,
});

const buildAction = (
  device: DevicePlanDevice,
  observedOverrides: Partial<TargetDeviceSnapshot> = {},
) => buildExecutableSteppedLoadDevice(
  buildExecutableSteppedLoadIntent(device),
  buildObservedState(device, observedOverrides),
);

describe('planExecutableSteppedLoad', () => {
  it('projects legacy step evidence into executor requested-step materialization', () => {
    const action = buildAction(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'max',
      reportedStepId: 'low',
      actualStepId: 'low',
      actualStepSource: 'reported',
    }));

    expect(action).toMatchObject({
      current: {
        on: false,
        stepId: 'low',
      },
      desired: {
        on: true,
        stepId: 'low',
        plannedStepId: 'low',
      },
      previousStepId: 'low',
      transition: {
        effectiveTransition: 'restore_from_off_at_low',
        transitionPhase: 'binary_transition',
      },
      stepActuation: {
        kind: 'requested',
        requestedStepId: 'low',
        materialization: { kind: 'materialized', stepId: 'low', source: 'observed' },
      },
    });
  });

  it('keeps fallback-only step evidence out of executor materialization', () => {
    const action = buildAction(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'low',
      assumedStepId: 'low',
      actualStepSource: 'assumed',
    }));

    expect(action?.stepActuation).toEqual({
      kind: 'requested',
      requestedStepId: 'low',
      materialization: { kind: 'not_materialized', reason: 'fallback_only' },
    });
    expect(action?.commandStepActuation).toEqual(action?.stepActuation);
  });

  it('uses measured power as shed baseline when current stepped position is unknown', () => {
    const action = buildAction(steppedPlanDevice({
      plannedState: 'shed',
      shedAction: 'set_step',
      selectedStepId: undefined,
      desiredStepId: 'low',
      measuredPowerKw: 3,
    }));

    expect(action?.current.stepForShed).toEqual({
      stepId: 'unknown',
      planningPowerW: 3000,
    });
    expect(action?.desired.stepId).toBe('low');
  });

  it('projects planner restore holds as no desired executor state change', () => {
    const intent = buildExecutableSteppedLoadIntent(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'max',
      reason: { code: 'meterSettling', remainingSec: 30 },
    }));

    expect(intent).toBeNull();
  });

  it('returns null for non stepped-load devices', () => {
    expect(buildExecutableSteppedLoadIntent(steppedPlanDevice({
      controlModel: 'binary_power',
      steppedLoadProfile: undefined,
    }))).toBeNull();
  });
});
