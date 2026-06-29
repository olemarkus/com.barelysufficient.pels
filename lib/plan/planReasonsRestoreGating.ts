import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import type { StructuredDebugEmitter } from '../logging/logger';
import {
  buildComparableDeviceReason,
  formatDeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import {
  getActivationPenaltyLevel,
  getActivationRestoreBlockCountdownTiming,
  getActivationRestoreBlockRemainingMs,
} from './admission';
import { resolveRestorePowerSource } from './restore/accounting';
import { getRestoreNeed } from './restore/support';
import {
  renderPlanReasonDecision,
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

export type HoldDecision =
  | { type: 'skip' }
  | { type: 'restore'; availableHeadroom: number; restoredOneThisCycle: boolean }
  | { type: 'hold'; reason: PlanReasonDecision };

function emitRestoreRejectedDebug(params: {
  state: PlanEngineState;
  restoreDebugKey: string;
  dev: DevicePlanDevice;
  phase: 'startup' | 'runtime';
  payload: Record<string, unknown>;
  signaturePayload: Record<string, unknown>;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const { state, restoreDebugKey, dev, phase, payload, signaturePayload, debugStructured } = params;
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_rejected',
      restoreType: 'target',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      ...payload,
    },
    signaturePayload: {
      event: 'restore_rejected',
      restoreType: 'target',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      ...signaturePayload,
    },
    debugStructured,
  });
}

export function resolveActivationBackoffHold(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  availableHeadroom: number;
  phase: 'startup' | 'runtime';
  restoreDebugKey: string;
  debugStructured?: StructuredDebugEmitter;
}): HoldDecision | null {
  const { dev, state, availableHeadroom, phase, restoreDebugKey, debugStructured } = params;
  const setbackRemainingMs = getActivationRestoreBlockRemainingMs({ state, deviceId: dev.id });
  if (setbackRemainingMs === null) return null;

  const reason: PlanReasonDecision = {
    code: 'activation_backoff',
    remainingMs: setbackRemainingMs,
    countdownTiming: getActivationRestoreBlockCountdownTiming({ state, deviceId: dev.id }),
  };
  const renderedReason = renderPlanReasonDecision(reason);
  const reasonText = formatDeviceReason(renderedReason);
  emitRestoreRejectedDebug({
    state,
    restoreDebugKey,
    dev,
    phase,
    payload: {
      reason: reasonText,
      availableKw: availableHeadroom,
      decision: 'rejected',
      decisionReason: reasonText,
      penaltyLevel: getActivationPenaltyLevel(state, dev.id),
    },
    signaturePayload: {
      reason: buildComparableDeviceReason(renderedReason),
      availableKw: availableHeadroom,
      decision: 'rejected',
      decisionReason: buildComparableDeviceReason(renderedReason),
      penaltyLevel: getActivationPenaltyLevel(state, dev.id),
    },
    debugStructured,
  });
  return { type: 'hold', reason };
}

export function resolveInsufficientHeadroomHold(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  availableHeadroom: number;
  phase: 'startup' | 'runtime';
  restoreDebugKey: string;
  restoreNeed: ReturnType<typeof getRestoreNeed>;
  admission: ReturnType<typeof buildRestoreAdmissionMetrics>;
  debugStructured?: StructuredDebugEmitter;
}): HoldDecision | null {
  const { dev, state, availableHeadroom, phase, restoreDebugKey, restoreNeed, admission, debugStructured } = params;
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
  const renderedReason = renderPlanReasonDecision(reason);
  const reasonText = formatDeviceReason(renderedReason);
  emitRestoreRejectedDebug({
    state,
    restoreDebugKey,
    dev,
    phase,
    payload: {
      reason: reasonText,
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'rejected',
      decisionReason: reasonText,
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
    },
    signaturePayload: {
      reason: buildComparableDeviceReason(renderedReason),
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'rejected',
      decisionReason: buildComparableDeviceReason(renderedReason),
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
    },
    debugStructured,
  });
  return { type: 'hold', reason };
}

export function resolveRestoreGateHold(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  restoredOneThisCycle: boolean;
  availableHeadroom: number;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  phase: 'startup' | 'runtime';
  restoreDebugKey: string;
  restoreNeed: ReturnType<typeof getRestoreNeed>;
  admission: ReturnType<typeof buildRestoreAdmissionMetrics>;
  debugStructured?: StructuredDebugEmitter;
}): HoldDecision | null {
  const {
    dev,
    state,
    restoredOneThisCycle,
    availableHeadroom,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    phase,
    restoreDebugKey,
    restoreNeed,
    admission,
    debugStructured,
  } = params;

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
  emitRestoreRejectedDebug({
    state,
    restoreDebugKey,
    dev,
    phase,
    payload: {
      reason: formatDeviceReason(gateReason),
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
      ...buildRestoreAdmissionLogFields(admission),
      decision: 'rejected',
      decisionReason: formatDeviceReason(gateReason),
    },
    signaturePayload: {
      reason: buildComparableDeviceReason(gateReason),
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
      ...buildRestoreAdmissionLogFields(admission),
      decision: 'rejected',
      decisionReason: buildComparableDeviceReason(gateReason),
    },
    debugStructured,
  });
  return { type: 'hold', reason };
}

export function resolveRestoreDecision(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  debugStructured?: StructuredDebugEmitter;
}): HoldDecision {
  const {
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    debugStructured,
  } = params;

  const phase = resolveRestoreDecisionPhase(state.currentRebuildReason);
  const restoreDebugKey = `target:${dev.id}`;
  const setbackHold = resolveActivationBackoffHold({
    dev, state, availableHeadroom, phase, restoreDebugKey, debugStructured,
  });
  if (setbackHold) return setbackHold;

  const restoreNeed = getRestoreNeed(dev, state);
  const admission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw: restoreNeed.needed });
  const headroomHold = resolveInsufficientHeadroomHold({
    dev, state, availableHeadroom, phase, restoreDebugKey, restoreNeed, admission, debugStructured,
  });
  if (headroomHold) return headroomHold;
  const gateHold = resolveRestoreGateHold({
    dev,
    state,
    restoredOneThisCycle,
    availableHeadroom,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    phase,
    restoreDebugKey,
    restoreNeed,
    admission,
    debugStructured,
  });
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
