import {
  isRequestedStepMaterialized,
  resolveSteppedStepActuationState,
} from '../lib/executor/steppedLoadActuation';
describe('steppedLoadActuation', () => {
  it('materializes a requested step only from reported observed evidence', () => {
    const state = resolveSteppedStepActuationState({
      step: { requestedStepId: 'low', observedStep: { kind: 'reported', stepId: 'low' } },
    });

    expect(state).toEqual({
      kind: 'requested',
      requestedStepId: 'low',
      materialization: { kind: 'materialized', stepId: 'low', source: 'observed' },
    });
    expect(isRequestedStepMaterialized(state)).toBe(true);
  });

  it('does not treat fallback evidence as materialization', () => {
    const state = resolveSteppedStepActuationState({
      step: { requestedStepId: 'low', observedStep: { kind: 'unknown' }, fallbackStepId: 'low' },
    });

    expect(state).toEqual({
      kind: 'requested',
      requestedStepId: 'low',
      materialization: { kind: 'not_materialized', reason: 'fallback_only' },
    });
    expect(isRequestedStepMaterialized(state)).toBe(false);
  });

  it('uses observed step evidence as materialization', () => {
    const state = resolveSteppedStepActuationState({
      step: { requestedStepId: 'low', observedStep: { kind: 'reported', stepId: 'low' } },
    });

    expect(state).toEqual({
      kind: 'requested',
      requestedStepId: 'low',
      materialization: { kind: 'materialized', stepId: 'low', source: 'observed' },
    });
  });

  it('does not materialize when observed step conflicts with requested step', () => {
    const state = resolveSteppedStepActuationState({
      step: { requestedStepId: 'low', observedStep: { kind: 'reported', stepId: 'max' } },
    });

    expect(state).toEqual({
      kind: 'requested',
      requestedStepId: 'low',
      materialization: { kind: 'not_materialized', reason: 'no_observed_match' },
    });
  });

  it('does not treat selected effective step alone as materialization', () => {
    const state = resolveSteppedStepActuationState({
      step: { requestedStepId: 'low', observedStep: { kind: 'unknown' } },
    });

    expect(state).toEqual({
      kind: 'requested',
      requestedStepId: 'low',
      materialization: { kind: 'not_materialized', reason: 'no_observed_match' },
    });
    expect(isRequestedStepMaterialized(state)).toBe(false);
  });

  it('keeps missing requested step explicit', () => {
    const state = resolveSteppedStepActuationState({
      step: { observedStep: { kind: 'reported', stepId: 'low' } },
    });

    expect(state).toEqual({
      kind: 'none',
      requestedStepId: undefined,
      materialization: { kind: 'not_materialized', reason: 'no_requested_step' },
    });
  });
});
