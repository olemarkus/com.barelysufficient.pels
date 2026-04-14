import { emitRestoreDebugEventOnChange } from '../lib/plan/planDebugDedupe';
import { createPlanEngineState } from '../lib/plan/planState';

describe('planDebugDedupe', () => {
  it('suppresses repeated cooldown/backoff chatter while the block reason is unchanged', () => {
    const state = createPlanEngineState();
    const debugStructured = vi.fn();

    emitRestoreDebugEventOnChange({
      state,
      key: 'setback:binary:dev-1',
      payload: {
        event: 'restore_blocked_setback',
        deviceId: 'dev-1',
        reason: 'activation backoff (10s remaining)',
        remainingMs: 10_000,
      },
      debugStructured,
    });
    emitRestoreDebugEventOnChange({
      state,
      key: 'setback:binary:dev-1',
      payload: {
        event: 'restore_blocked_setback',
        deviceId: 'dev-1',
        reason: 'activation backoff (9s remaining)',
        remainingMs: 9_000,
      },
      debugStructured,
    });

    expect(debugStructured).toHaveBeenCalledTimes(1);
  });

  it('emits again when the restore decision materially changes', () => {
    const state = createPlanEngineState();
    const debugStructured = vi.fn();

    emitRestoreDebugEventOnChange({
      state,
      key: 'stepped:dev-1',
      payload: {
        event: 'restore_stepped_admitted',
        deviceId: 'dev-1',
        currentStepId: 'step-1',
        toStepId: 'step-2',
        availableKw: 1.24,
      },
      debugStructured,
    });
    emitRestoreDebugEventOnChange({
      state,
      key: 'stepped:dev-1',
      payload: {
        event: 'restore_stepped_admitted',
        deviceId: 'dev-1',
        currentStepId: 'step-1',
        toStepId: 'step-2',
        availableKw: 1.241,
      },
      debugStructured,
    });
    emitRestoreDebugEventOnChange({
      state,
      key: 'stepped:dev-1',
      payload: {
        event: 'restore_stepped_admitted',
        deviceId: 'dev-1',
        currentStepId: 'step-1',
        toStepId: 'step-3',
        availableKw: 1.24,
      },
      debugStructured,
    });

    expect(debugStructured).toHaveBeenCalledTimes(2);
  });

  it('does not cache signatures when no emitter is configured', () => {
    const state = createPlanEngineState();

    emitRestoreDebugEventOnChange({
      state,
      key: 'stepped:dev-1',
      payload: {
        event: 'restore_stepped_admitted',
        deviceId: 'dev-1',
        toStepId: 'step-2',
      },
    });

    expect(state.restoreDecisionLogByKey['stepped:dev-1']).toBeUndefined();
  });
});
