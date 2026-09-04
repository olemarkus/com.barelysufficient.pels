import type { DevicePlanDevice } from './planTypes';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import {
  buildReservedForStartReason,
  getActivationPenaltyLevel,
  getActivationRestoreBlockCountdownTiming,
  getActivationRestoreBlockRemainingMs,
  resolveReserveAdmission,
} from './admission';
import { resolveRestorePowerSource } from './restore/accounting';
import { getRestoreNeed } from './restore/support';
import {
  type PlanReasonDecision,
} from './planReasonStrings';
import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  resolveRestoreDecisionPhase,
} from './admission';
import { RESTORE_ADMISSION_FLOOR_KW } from './planConstants';
import { resolveCapacityRestoreBlockReason } from './restore/timing';
import { emitRestoreDebugEventOnChange } from './planDebugDedupe';
import { buildRestoreHeadroomLedger, type RestoreHeadroomLedger } from './restore/headroomLedger';
import type { RestoreCooldownPreview } from './restore/types';
import type { HoldLoopState, HoldPass } from './planReasonsShared';

export type RestoreCooldownPreviewState = {
  holdReason: DeviceReason;
  selectedOne: boolean;
  appliesToAllCandidates: boolean;
  ledger: RestoreHeadroomLedger;
};

export const buildRestoreCooldownPreviewState = (
  preview: RestoreCooldownPreview,
): RestoreCooldownPreviewState => ({
  holdReason: preview.holdReason,
  selectedOne: preview.selectedOne,
  appliesToAllCandidates: preview.appliesToAllCandidates,
  ledger: buildRestoreHeadroomLedger({
    capacityAvailableKw: preview.capacityAvailableKw,
    budgetAvailableKw: preview.budgetAvailableKw,
  }),
});

export function resolveGlobalRestoreHold(
  preview: RestoreCooldownPreviewState | undefined,
  wasShedLastPlan: boolean,
  observedAtShedFloor: boolean,
): HoldDecision | null {
  if (!preview?.appliesToAllCandidates || !wasShedLastPlan || !observedAtShedFloor) return null;
  return { type: 'hold', reason: { code: 'existing', reason: preview.holdReason } };
}

// Reads the preview off the pass rather than taking it as a parameter: the
// claim below mutates it (debit the ledger, mark the single slot spent), and a
// parameter's properties are not ours to assign to.
function resolveCooldownPreviewHold(
  pass: HoldPass,
  dev: DevicePlanDevice,
  restoreNeedKw: number,
): HoldDecision | null {
  const preview = pass.cooldownPreviewState;
  if (!preview) return null;
  const selected = !preview.selectedOne;
  const reason = selected
    ? preview.holdReason
    : { code: PLAN_REASON_CODES.waitingForOtherDevices } as const;
  if (selected) {
    preview.ledger.commit(dev, restoreNeedKw);
    preview.selectedOne = true;
  }
  return { type: 'hold', reason: { code: 'existing', reason } };
}

export type HoldDecision =
  | { type: 'skip' }
  | { type: 'restore'; availableHeadroom: number; restoredOneThisCycle: boolean }
  | { type: 'hold'; reason: PlanReasonDecision };

function emitRestoreRejectedDebug(
  pass: HoldPass,
  dev: DevicePlanDevice,
  restoreDebugKey: string,
  /**
   * Which gate rejected the restore, as a code. Required, and required here
   * rather than left to each caller's payload: these branches differ only in
   * their numbers, and two of them (insufficient power, restore gate) carry the
   * same numeric fields. With the payload serving as its own dedupe signature,
   * dropping it would let a transition BETWEEN causes be suppressed whenever
   * the numbers happened to match.
   */
  rejectionReason: string,
  payload: Record<string, unknown>,
): void {
  const { state, debugStructured } = pass;
  const phase = resolveRestoreDecisionPhase(state.currentRebuildTrigger);
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_rejected',
      restoreType: 'target',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      rejectionReason,
      ...payload,
    },
    debugStructured,
  });
}

export function resolveActivationBackoffHold(
  pass: HoldPass,
  dev: DevicePlanDevice,
  availableHeadroom: number,
): HoldDecision | null {
  const { state } = pass;
  const restoreDebugKey = `target:${dev.id}`;
  const setbackRemainingMs = getActivationRestoreBlockRemainingMs({ state, deviceId: dev.id });
  if (setbackRemainingMs === null) return null;

  const reason: PlanReasonDecision = {
    code: 'activation_backoff',
    remainingMs: setbackRemainingMs,
    countdownTiming: getActivationRestoreBlockCountdownTiming({ state, deviceId: dev.id }),
  };
  emitRestoreRejectedDebug(pass, dev, restoreDebugKey, PLAN_REASON_CODES.activationBackoff, {
      availableKw: availableHeadroom,
      decision: 'rejected',
      penaltyLevel: getActivationPenaltyLevel(state, dev.id),
    });
  return { type: 'hold', reason };
}

export function resolveInsufficientHeadroomHold(
  pass: HoldPass,
  dev: DevicePlanDevice,
  availableHeadroom: number,
  restoreNeed: ReturnType<typeof getRestoreNeed>,
  admission: ReturnType<typeof buildRestoreAdmissionMetrics>,
): HoldDecision | null {
  const restoreDebugKey = `target:${dev.id}`;
  if (admission.postReserveMarginKw >= RESTORE_ADMISSION_FLOOR_KW) return null;

  const reason: PlanReasonDecision = {
    code: 'restore_headroom',
    params: {
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      postReserveMarginKw: admission.postReserveMarginKw,
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      penaltyExtraKw: restoreNeed.penaltyExtraKw,
    },
  };
  emitRestoreRejectedDebug(pass, dev, restoreDebugKey, PLAN_REASON_CODES.insufficientHeadroom, {
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'rejected',
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
    });
  return { type: 'hold', reason };
}

export function resolveRestoreGateHold(
  pass: HoldPass,
  dev: DevicePlanDevice,
  loop: HoldLoopState,
  restoreNeed: ReturnType<typeof getRestoreNeed>,
  admission: ReturnType<typeof buildRestoreAdmissionMetrics>,
): HoldDecision | null {
  const { restoreCooldownSeconds, restoreCooldownRemainingSec } = pass;
  const { availableHeadroom, restoredOneThisCycle } = loop;
  const restoreDebugKey = `target:${dev.id}`;

  const gateReason = resolveCapacityRestoreBlockReason({
    timing: {
      activeOvershoot: false,
      inCooldown: false,
      inRestoreCooldown: false,
      inStartupStabilization: false,
      restoreCooldownSeconds,
      shedCooldownRemainingSec: null,
      restoreCooldownRemainingSec,
    },
    restoredOneThisCycle,
    useThrottleLabel: true,
  });
  if (!gateReason) return null;

  const reason: PlanReasonDecision = { code: 'existing', reason: gateReason };
  emitRestoreRejectedDebug(pass, dev, restoreDebugKey, gateReason.code, {
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
      ...buildRestoreAdmissionLogFields(admission),
      decision: 'rejected',
    });
  return { type: 'hold', reason };
}

export function resolveRestoreDecision(
  pass: HoldPass,
  dev: DevicePlanDevice,
  loop: HoldLoopState,
  /**
   * Whether the DEVICE currently reports the shed-floor target. A reserve block
   * on a device that has not reached its floor must keep the actuating shed
   * reason, because `reservedForStart` builds no intent — swapping it in early
   * would stop the pending floor command's retry while the device keeps drawing
   * inside the reserved block.
   */
  observedAtShedFloor: boolean,
  baseShedReason: PlanReasonDecision | undefined,
): HoldDecision {
  const { state, restoredThisCycle, headroomReserves, debugStructured } = pass;
  const { availableHeadroom } = loop;
  const phase = resolveRestoreDecisionPhase(state.currentRebuildTrigger);
  const restoreDebugKey = `target:${dev.id}`;
  const setbackHold = resolveActivationBackoffHold(pass, dev, availableHeadroom);
  if (setbackHold) return setbackHold;

  const restoreNeed = getRestoreNeed(dev, state);
  // Admit against the power this device may actually claim: raw available power
  // minus any startup reservation held by a strictly higher-priority device that
  // (`restore/gating.ts`). Without it, a setpoint raise was the one restore that
  // could take a reserved block: PELS itself giving the promised power away.
  const reserved = resolveReserveAdmission({
    dev, availableHeadroom, neededKw: restoreNeed.needed, reserves: headroomReserves,
  });
  if (reserved.kind === 'blocked_by_reserve') {
    // Enough raw power — it is just promised to a device about to start. Name
    // the holder on the card; this lane has no swap fallback to defeat.
    //
    // Unless the device has not actually reached its shed floor yet: then the
    // original shed must keep asserting (an ACTUATING reason), because
    // `reservedForStart` is in `RESTORE_ADMISSION_HOLD_REASON_CODES` and
    // builds no intent — swapping it in early would stop the pending floor
    // command's retry while the device keeps drawing inside the reserved
    // block.
    if (observedAtShedFloor !== true && baseShedReason !== undefined) {
      return { type: 'hold', reason: baseShedReason };
    }
    const reservedReason = buildReservedForStartReason(reserved.holderName);
    emitRestoreRejectedDebug(pass, dev, restoreDebugKey, reservedReason.code, {
        estimatedPowerKw: restoreNeed.devPower,
        powerSource: resolveRestorePowerSource(dev),
        neededKw: restoreNeed.needed,
        availableKw: availableHeadroom,
        reservedKw: reserved.reservedKw,
        decision: 'rejected',
      });
    return { type: 'hold', reason: { code: 'existing', reason: reservedReason } };
  }
  const { admission } = reserved;
  const headroomHold = resolveInsufficientHeadroomHold(
    pass, dev, availableHeadroom, restoreNeed, admission,
  );
  if (headroomHold) return headroomHold;
  const previewHold = resolveCooldownPreviewHold(pass, dev, restoreNeed.needed);
  if (previewHold) return previewHold;
  const gateHold = resolveRestoreGateHold(pass, dev, loop, restoreNeed, admission);
  if (gateHold) return gateHold;
  restoredThisCycle.add(dev.id);
  const powerSource = resolveRestorePowerSource(dev);
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_admitted',
      restoreType: 'target',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      estimatedPowerKw: restoreNeed.devPower,
      powerSource,
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      decision: 'admitted',
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
    },
    debugStructured,
  });
  return {
    type: 'restore',
    availableHeadroom: availableHeadroom - restoreNeed.needed,
    restoredOneThisCycle: true,
  };
}
