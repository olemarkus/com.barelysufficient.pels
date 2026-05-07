import { describe, expect, it } from 'vitest';
import { buildExecutableSteppedLoadDevice } from '../lib/executor/executableSteppedLoadProjection';
import { steppedPlanDevice } from './utils/planTestUtils';

describe('planExecutableSteppedLoad', () => {
  it('projects legacy step evidence into executor requested-step materialization', () => {
    const action = buildExecutableSteppedLoadDevice(steppedPlanDevice({
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
    const action = buildExecutableSteppedLoadDevice(steppedPlanDevice({
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
    const action = buildExecutableSteppedLoadDevice(steppedPlanDevice({
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
    const action = buildExecutableSteppedLoadDevice(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'low',
      desiredStepId: 'max',
      reason: { code: 'meterSettling', remainingSec: 30 },
    }));

    expect(action).toMatchObject({
      current: {
        on: false,
        stepId: 'low',
      },
      desired: {
        on: false,
        stepId: 'low',
        plannedStepId: 'low',
      },
      transition: null,
    });
    expect(action).not.toHaveProperty('reason');
  });

  it('returns null for non stepped-load devices', () => {
    expect(buildExecutableSteppedLoadDevice(steppedPlanDevice({
      controlModel: 'binary_power',
      steppedLoadProfile: undefined,
    }))).toBeNull();
  });
});
