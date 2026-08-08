import {
  allowsSteppedLoadKeepInvariantRestore,
  isActivationPenaltyBlockedReason,
  isCooldownBlockedReason,
  isDeferredRestoreBlockedReason,
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
    // Load-bearing: this membership is the ONLY thing making "a startup reservation issues no
    // writes" structurally true. The stand-down path stamps `plannedState: 'shed'` via the shared
    // `rejectBinaryRestore`, so without this entry `buildExecutableBinaryShedIntent` would build a
    // turn-off intent for every reserved device. Claimed in lib/plan/AGENTS.md and
    // notes/deferred-load-objectives/preemptive-power-reservation.md.
    expect(isRestoreAdmissionHoldReason(reason(PLAN_REASON_CODES.reservedForStart))).toBe(true);
  });

  it('blocks a smart-task resume from lifting another task\'s startup reservation', () => {
    // The reserving device outranks this one by construction, so a deferred binary_restore here
    // would take exactly the block the reservation protects.
    expect(isDeferredRestoreBlockedReason(reason(PLAN_REASON_CODES.reservedForStart))).toBe(true);
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

  // Pins the classifier the `insufficientHeadroom` → `dailyBudget` re-attribution
  // in `normalizeShedReasons` changes exposure to: budget reason codes are absent
  // from DEFERRED_RESTORE_BLOCK_REASON_CODES while capacity/headroom stay blocked.
  // The coupling is LATENT today — `buildExecutableReleaseIntent` requires
  // `plannedState === 'keep'` before consulting the reason, and every
  // re-attributed hold is a shed device, so no binary_restore actually lifts a
  // budget hold through the fold. If budget holds ever ride keep-state devices,
  // this membership becomes load-bearing; change it deliberately, not by
  // accident.
  it('classifies budget holds as non-blocking for deferred restores (latent — keep-gate applies)', () => {
    expect(isDeferredRestoreBlockedReason(reason(PLAN_REASON_CODES.dailyBudget))).toBe(false);
    expect(isDeferredRestoreBlockedReason(reason(PLAN_REASON_CODES.hourlyBudget))).toBe(false);
    expect(isDeferredRestoreBlockedReason(reason(PLAN_REASON_CODES.capacity))).toBe(true);
    expect(isDeferredRestoreBlockedReason(reason(PLAN_REASON_CODES.insufficientHeadroom))).toBe(true);
  });

  it('maps reason codes to starvation suppression semantics', () => {
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.capacity))).toEqual({
      state: 'counting',
      countingCause: 'capacity',
      pauseReason: null,
    });
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.keep))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'keep',
    });
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.inactive))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'inactive',
    });
  });

  // The 2026-08-08 owner ruling: the clock runs whenever PELS is the reason the device is
  // down. Every hold here USED to pause it, which is what made a device cycling between a
  // capacity hold and a 60 s cooldown look like it had been served. Each keeps its own
  // cause — device detail renders it, so a cooldown must not read as a reservation.
  it('counts every hold PELS itself imposes, attributed to the specific hold', () => {
    const countingCauseByCode = {
      [PLAN_REASON_CODES.cooldownShedding]: 'cooldown',
      [PLAN_REASON_CODES.cooldownRestore]: 'cooldown',
      [PLAN_REASON_CODES.meterSettling]: 'cooldown',
      [PLAN_REASON_CODES.restorePending]: 'restore',
      [PLAN_REASON_CODES.waitingForOtherDevices]: 'restore',
      [PLAN_REASON_CODES.restoreThrottled]: 'restore_throttled',
      [PLAN_REASON_CODES.activationBackoff]: 'activation_backoff',
      [PLAN_REASON_CODES.reservedForStart]: 'reserved_for_start',
    };

    Object.entries(countingCauseByCode).forEach(([code, countingCause]) => {
      expect(resolveStarvationSuppressionSemantics(reason(code as DeviceReason['code']))).toEqual({
        state: 'counting',
        countingCause,
        pauseReason: null,
      });
    });
  });

  // `restoreNeed` is the one restore code that must NOT follow its siblings above: it lands
  // on a keep-state device that is ON and merely wants a step up, so PELS has not turned it
  // off and the clock stays stopped.
  it('keeps a stepped step-up need paused — the device is running', () => {
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.restoreNeed))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'restore',
    });
  });

  // The carve-out from the ruling: PELS did turn these off, but at the owner's own explicit
  // request. Flagging "Held back" and offering "Let it run now" would be telling the owner
  // their own setting is a problem, so the clock stays stopped however long the hold runs.
  it('pauses the holds the owner asked for', () => {
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.deferredObjectiveAvoid))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'deferred_objective_avoid',
    });
    expect(resolveStarvationSuppressionSemantics(reason(PLAN_REASON_CODES.awaitingSolarSurplus))).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'awaiting_solar_surplus',
    });
  });
});
