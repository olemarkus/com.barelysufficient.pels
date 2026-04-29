import {
  isRestoreStepPrepared,
  normalizeSteppedLoadStepState,
  resolveEffectiveStepId,
  serializeLegacyStepFields,
} from '../lib/plan/planSteppedLoadState';

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
      actualStepId: undefined,
      assumedStepId: undefined,
      actualStepSource: undefined,
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
      actualStepId: undefined,
      assumedStepId: 'low',
      actualStepSource: 'assumed',
      restorePreparedStepId: undefined,
    });
  });

  it('allows suppressed flow feedback as restore preparation only when tied to current intent', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      targetStep: { stepId: 'low', changedAtMs: 1_500, status: 'pending' },
      suppressedFlowStep: { stepId: 'low', observedAtMs: 1_600 },
      suppressedFlowPreparationPolicy: { kind: 'intent_match', maxAgeMs: 1_000 },
    });

    expect(state.observation).toEqual({ kind: 'unknown' });
    expect(state.restorePreparation).toEqual({
      kind: 'prepared',
      stepId: 'low',
      source: 'suppressed_flow',
      observedAtMs: 1_600,
    });
  });

  it('does not let stale suppressed flow feedback prepare restore', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 4_000,
      targetStep: { stepId: 'low', changedAtMs: 1_500, status: 'pending' },
      suppressedFlowStep: { stepId: 'low', observedAtMs: 1_600 },
      suppressedFlowPreparationPolicy: { kind: 'intent_match', maxAgeMs: 1_000 },
    });

    expect(state.restorePreparation).toEqual({ kind: 'not_prepared' });
  });

  it('does not let future-dated suppressed flow feedback prepare restore', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      targetStep: { stepId: 'low', changedAtMs: 1_500, status: 'pending' },
      suppressedFlowStep: { stepId: 'low', observedAtMs: 2_100 },
      suppressedFlowPreparationPolicy: { kind: 'intent_match', maxAgeMs: 1_000 },
    });

    expect(state.restorePreparation).toEqual({ kind: 'not_prepared' });
  });

  it('does not let fallback matching the lowest active step prepare restore without runtime intent', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      planningFallback: { stepId: 'low', reason: 'lowest_active_step' },
      suppressedFlowStep: { stepId: 'low', observedAtMs: 1_900 },
      suppressedFlowPreparationPolicy: { kind: 'intent_match', maxAgeMs: 1_000 },
    });

    expect(resolveEffectiveStepId(state)).toBe('low');
    expect(state.intent).toEqual({ kind: 'none' });
    expect(state.restorePreparation).toEqual({ kind: 'not_prepared' });
  });

  it('does not let mismatched suppressed flow feedback prepare restore', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      targetStep: { stepId: 'low', changedAtMs: 1_500, status: 'pending' },
      suppressedFlowStep: { stepId: 'max', observedAtMs: 1_600 },
      suppressedFlowPreparationPolicy: { kind: 'intent_match', maxAgeMs: 1_000 },
    });

    expect(state.restorePreparation).toEqual({ kind: 'not_prepared' });
  });

  it('keeps explicit freshness policy separate from intent-tied suppressed flow policy', () => {
    const state = normalizeSteppedLoadStepState({
      nowMs: 2_000,
      suppressedFlowStep: { stepId: 'low', observedAtMs: 1_900 },
      suppressedFlowPreparationPolicy: { kind: 'fresh', maxAgeMs: 200 },
    });

    expect(state.intent).toEqual({ kind: 'none' });
    expect(state.restorePreparation).toEqual({
      kind: 'prepared',
      stepId: 'low',
      source: 'suppressed_flow',
      observedAtMs: 1_900,
    });
  });

  it('matches restore preparation only by explicit prepared and desired step ids', () => {
    expect(isRestoreStepPrepared({ preparedStepId: 'low', desiredStepId: 'low' })).toBe(true);
    expect(isRestoreStepPrepared({ preparedStepId: 'max', desiredStepId: 'low' })).toBe(false);
    expect(isRestoreStepPrepared({ preparedStepId: undefined, desiredStepId: 'low' })).toBe(false);
    expect(isRestoreStepPrepared({ preparedStepId: 'low', desiredStepId: undefined })).toBe(false);
  });
});
