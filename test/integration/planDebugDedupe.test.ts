import { emitRestoreDebugEventOnChange } from '../../lib/plan/planDebugDedupe';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import {
  buildComparableDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { setDebugTopics } from '../../lib/logging/logger';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

// Emission is gated on the `plan` topic — the function resolves its own
// emitter, so the capture is how a spec observes it. The capture owns the
// destination too, so an enabled topic does not write onto stdout.
let capture: LoggerCapture;
beforeEach(() => { capture = captureLogger('debug', ['plan']); });
afterEach(() => { capture.restore(); });

describe('planDebugDedupe', () => {
  it('suppresses repeated cooldown/backoff chatter while the block reason is unchanged', () => {
    const state = createPlanEngineState();

    emitRestoreDebugEventOnChange({
      state,
      key: 'setback:binary:dev-1',
      payload: {
        event: 'restore_blocked_setback',
        deviceId: 'dev-1',
        reason: 'activation backoff (10s remaining)',
        remainingMs: 10_000,
      },
      signaturePayload: {
        event: 'restore_blocked_setback',
        deviceId: 'dev-1',
        reason: buildComparableDeviceReason({
          code: PLAN_REASON_CODES.activationBackoff,
          remainingSec: 10,
        }),
      },
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
      signaturePayload: {
        event: 'restore_blocked_setback',
        deviceId: 'dev-1',
        reason: buildComparableDeviceReason({
          code: PLAN_REASON_CODES.activationBackoff,
          remainingSec: 9,
        }),
      },
    });

    expect(capture.findEvents('restore_blocked_setback')).toHaveLength(1);
  });

  it('emits again when the restore decision materially changes', () => {
    const state = createPlanEngineState();

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
    });

    expect(capture.findEvents('restore_stepped_admitted')).toHaveLength(2);
  });

  it('skips the signature work when the topic is off', () => {
    // The old gate asked whether the caller passed an emitter, which the plan
    // wiring does unconditionally — so it was always open, and this walked and
    // stringified a payload on every restore decision with `plan` switched off.
    // The absent map entry is the proof it now returns before that work.
    setDebugTopics(new Set());
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

    expect(capture.events).toHaveLength(0);
    expect(state.restoreDecisionLogByKey['stepped:dev-1']).toBeUndefined();
  });
});
