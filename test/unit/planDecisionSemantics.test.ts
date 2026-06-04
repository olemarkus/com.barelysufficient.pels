import {
  allowsSteppedLoadKeepInvariantRestore,
  isActivationPenaltyBlockedReason,
  isCooldownBlockedReason,
  isRestoreAdmissionHoldReason,
  isShedInvariantBlockedReason,
  resolveStarvationSuppressionSemantics,
} from '../../lib/planContract/planDecisionSemantics';
import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';

const reason = (code: DeviceReason['code']): DeviceReason => ({ code } as DeviceReason);

describe('plan decision semantics', () => {
  it('classifies restore hold reasons for projection materialization', () => {
    expect(isRestoreAdmissionHoldReason(reason(PLAN_REASON_CODES.meterSettling))).toBe(true);
    expect(isRestoreAdmissionHoldReason(reason(PLAN_REASON_CODES.cooldownRestore))).toBe(true);
    expect(isRestoreAdmissionHoldReason(reason(PLAN_REASON_CODES.cooldownShedding))).toBe(false);
  });

  it('classifies stepped keep invariant restore allow reasons', () => {
    expect(allowsSteppedLoadKeepInvariantRestore(reason(PLAN_REASON_CODES.keep))).toBe(true);
    expect(allowsSteppedLoadKeepInvariantRestore(reason(PLAN_REASON_CODES.restoreNeed))).toBe(true);
    expect(allowsSteppedLoadKeepInvariantRestore(reason(PLAN_REASON_CODES.cooldownRestore))).toBe(false);
  });

  it('classifies planner summary block categories', () => {
    expect(isCooldownBlockedReason(reason(PLAN_REASON_CODES.cooldownShedding))).toBe(true);
    expect(isCooldownBlockedReason(reason(PLAN_REASON_CODES.restorePending))).toBe(true);
    expect(isCooldownBlockedReason(reason(PLAN_REASON_CODES.activationBackoff))).toBe(false);

    expect(isActivationPenaltyBlockedReason(reason(PLAN_REASON_CODES.activationBackoff))).toBe(true);
    expect(isActivationPenaltyBlockedReason(reason(PLAN_REASON_CODES.cooldownRestore))).toBe(false);

    expect(isShedInvariantBlockedReason(reason(PLAN_REASON_CODES.shedInvariant))).toBe(true);
    expect(isShedInvariantBlockedReason(reason(PLAN_REASON_CODES.keep))).toBe(false);
  });

  it('maps reason codes to starvation suppression semantics', () => {
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.capacity))).toEqual({
      state: 'counting',
      countingCause: 'capacity',
      pauseReason: null,
    });
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.restorePending))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'restore',
    });
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.activationBackoff))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'activation_backoff',
    });
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.keep))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'keep',
    });
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.deferredObjectiveAvoid))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'deferred_objective_avoid',
    });
  });
});
