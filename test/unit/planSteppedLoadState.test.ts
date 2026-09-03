import {
  normalizeSteppedLoadStepState,
  resolveEffectiveStepId,
  serializeLegacyStepFields,
} from '../../lib/plan/planSteppedLoadState';

describe('planSteppedLoadState', () => {
  it('keeps reported observation, target intent, and fallback assumption as distinct state', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      reportedStep: { stepId: 'low', source: 'native', observedAtMs: 1_500 },
      targetStep: { stepId: 'max', changedAtMs: 1_700, status: 'pending' },
      planningFallback: { stepId: 'low', reason: 'lowest_active_step' },
    });

    expect(state).toEqual({
      observation: { kind: 'reported', stepId: 'low', source: 'native', observedAtMs: 1_500 },
      intent: { kind: 'target', stepId: 'max', changedAtMs: 1_700, status: 'pending' },
      planningAssumption: { kind: 'fallback', stepId: 'low', reason: 'lowest_active_step' },
      restorePreparation: { kind: 'prepared', stepId: 'low', source: 'reported', observedAtMs: 1_500 },
    });
    expect(resolveEffectiveStepId(state)).toBe('low');
    expect(state.restorePreparation).toEqual({
      kind: 'prepared',
      stepId: 'low',
      source: 'reported',
      observedAtMs: 1_500,
    });
  });

  it('represents unknown explicitly and derives legacy fields only at serialization', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      targetStep: { stepId: 'max', changedAtMs: 1_700, status: 'pending' },
    });

    expect(state.observation).toEqual({ kind: 'unknown' });
    expect(state.planningAssumption).toEqual({ kind: 'none' });
    expect(state.restorePreparation).toEqual({ kind: 'not_prepared' });
    expect(resolveEffectiveStepId(state)).toBe('unknown');
    expect(serializeLegacyStepFields(state)).toEqual({
      reportedStepId: undefined,
      targetStepId: 'max',
      desiredStepId: 'max',
      selectedStepId: undefined,
      restorePreparedStepId: undefined,
    });
  });

  it('serializes reported and fallback evidence without making fallback restore proof', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      planningFallback: { stepId: 'low', reason: 'lowest_active_step' },
    });

    expect(resolveEffectiveStepId(state)).toBe('low');
    expect(state.restorePreparation).toEqual({ kind: 'not_prepared' });
    expect(serializeLegacyStepFields(state)).toEqual({
      reportedStepId: undefined,
      targetStepId: undefined,
      desiredStepId: undefined,
      selectedStepId: 'low',
      restorePreparedStepId: undefined,
    });
  });

  it('does not let a planning fallback prepare restore without a reported step', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      planningFallback: { stepId: 'low', reason: 'lowest_active_step' },
    });

    expect(resolveEffectiveStepId(state)).toBe('low');
    expect(state.intent).toEqual({ kind: 'none' });
    expect(state.restorePreparation).toEqual({ kind: 'not_prepared' });
  });

  it('prepares restore from a reported step however long ago it was observed', () => {
    // No age test anywhere: `lib/plan` holds no concept of observation freshness,
    // and a Homey driver only republishes on CHANGE, so an old stamp means
    // "unchanged", not "unknown".
    const state = normalizeSteppedLoadStepState({
      nowMs: 9_000_000,
      reportedStep: { stepId: 'low', source: 'flow', observedAtMs: 1_600 },
    });

    expect(state.restorePreparation).toEqual({
      kind: 'prepared',
      stepId: 'low',
      source: 'reported',
      observedAtMs: 1_600,
    });
  });
});
