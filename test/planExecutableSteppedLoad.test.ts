import { describe, expect, it } from 'vitest';
import { buildExecutableSteppedLoadDevice } from '../lib/plan/planExecutableSteppedLoad';
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
      requestedStepId: 'low',
      commandStepId: 'low',
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

  it('returns null for non stepped-load devices', () => {
    expect(buildExecutableSteppedLoadDevice(steppedPlanDevice({
      controlModel: 'binary_power',
      steppedLoadProfile: undefined,
    }))).toBeNull();
  });
});
