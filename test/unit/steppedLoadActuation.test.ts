import {
  isRequestedStepMaterialized,
  resolveSteppedStepActuationState,
} from '../../lib/executor/steppedLoadActuation';
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

  // A flow-confirmed step command is restore-preparation evidence for a device
  // that is off: no observed report can exist there (non-off flow reports are
  // suppressed while off), so the confirmed command is the flow-transport
  // analogue of a native capability echo (prod 2026-07-05 Elbillader deadlock).
  it('materializes a requested step from a confirmed step command when no report exists', () => {
    const state = resolveSteppedStepActuationState({
      step: { requestedStepId: '6a', observedStep: { kind: 'unknown' }, confirmedCommandStepId: '6a' },
    });

    expect(state).toEqual({
      kind: 'requested',
      requestedStepId: '6a',
      materialization: { kind: 'materialized', stepId: '6a', source: 'confirmed_command' },
    });
    expect(isRequestedStepMaterialized(state)).toBe(true);
  });

  it('materializes from a confirmed command over a contradicting off-step report', () => {
    // The observed 'off' report predates the confirmed prepare-for-on command
    // (shed set the device to its off step; the restore prepared '6a').
    const state = resolveSteppedStepActuationState({
      step: {
        requestedStepId: '6a',
        observedStep: { kind: 'reported', stepId: 'off' },
        confirmedCommandStepId: '6a',
      },
    });

    expect(state.materialization).toEqual({
      kind: 'materialized', stepId: '6a', source: 'confirmed_command',
    });
  });

  it('does not materialize from a confirmed command for a different step', () => {
    const state = resolveSteppedStepActuationState({
      step: { requestedStepId: '8a', observedStep: { kind: 'unknown' }, confirmedCommandStepId: '6a' },
    });

    expect(state.materialization).toEqual({ kind: 'not_materialized', reason: 'no_observed_match' });
    expect(isRequestedStepMaterialized(state)).toBe(false);
  });

  it('prefers observed-report materialization over a confirmed command', () => {
    const state = resolveSteppedStepActuationState({
      step: {
        requestedStepId: '6a',
        observedStep: { kind: 'reported', stepId: '6a' },
        confirmedCommandStepId: '6a',
      },
    });

    expect(state.materialization).toEqual({ kind: 'materialized', stepId: '6a', source: 'observed' });
  });
});
