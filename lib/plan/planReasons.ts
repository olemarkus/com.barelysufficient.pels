/* eslint-disable max-lines -- reason normalization and shed-temperature hold decisions share stateful helpers here */
import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import type { Logger as PinoLogger } from '../logging/logger';
import { getActivationPenaltyLevel, getActivationRestoreBlockRemainingMs } from './planActivationBackoff';
import { resolveRestorePowerSource } from './planRestoreSwap';
import { getRestoreNeed } from './planRestore';
import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  resolveRestoreDecisionPhase,
  shouldLogRestoreAdmissionAtInfo,
} from './planRestoreAdmission';
import {
  buildBaseReason,
  getBaseShedReason,
  getReasonFlags,
  maybeApplyCooldownReason,
  maybeApplyShortfallReason,
  shouldNormalizeKeepReason as shouldNormalizeReason,
} from './planReasonHelpers';
import { sortByPriorityAsc } from './planSort';
import { RESTORE_ADMISSION_FLOOR_KW, RESTORE_CONFIRM_RETRY_MS } from './planConstants';
import { resolveCapacityRestoreBlockReason } from './planRestoreTiming';

export type ShedHoldParams = {
  planDevices: DevicePlanDevice[];
  state: PlanEngineState;
  shedReasons: Map<string, string>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  structuredLog?: PinoLogger;
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  };
};

export function applyShedTemperatureHold(params: ShedHoldParams): {
  planDevices: DevicePlanDevice[];
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
} {
  const {
    planDevices,
    state,
    shedReasons,
    inShedWindow,
    inCooldown,
    activeOvershoot,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    shedCooldownRemainingSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    structuredLog,
    getShedBehavior,
  } = params;

  let headroom = availableHeadroom;
  let restoredOne = restoredOneThisCycle;
  const nextDevices: DevicePlanDevice[] = [];
  const pendingRestoreDelaySec = getPendingRestoreDelaySeconds(planDevices, state, getShedBehavior);

  for (const dev of planDevices) {
    const behavior = getShedBehavior(dev.id);
    const result = applyHoldToDevice({
      dev,
      behavior,
      state,
      shedReasons,
      inShedWindow,
      inCooldown,
      activeOvershoot,
      availableHeadroom: headroom,
      restoredOneThisCycle: restoredOne,
      restoredThisCycle,
      shedCooldownRemainingSec,
      holdDuringRestoreCooldown,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelaySec,
      structuredLog,
    });
    headroom = result.availableHeadroom;
    restoredOne = result.restoredOneThisCycle;
    nextDevices.push(result.device);
  }

  return {
    planDevices: nextDevices,
    availableHeadroom: headroom,
    restoredOneThisCycle: restoredOne,
  };
}

export function normalizeShedReasons(params: {
  planDevices: DevicePlanDevice[];
  shedReasons: Map<string, string>;
  guardInShortfall: boolean;
  headroomRaw: number | null;
  inCooldown: boolean;
  activeOvershoot: boolean;
  inRestoreCooldown: boolean;
  shedCooldownRemainingSec: number | null;
  restoreCooldownRemainingSec: number | null;
}): DevicePlanDevice[] {
  const {
    planDevices,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    inRestoreCooldown,
    shedCooldownRemainingSec,
    restoreCooldownRemainingSec,
  } = params;

  return planDevices.map((dev) => normalizeDeviceReason({
    dev,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    inRestoreCooldown,
    shedCooldownRemainingSec,
    restoreCooldownRemainingSec,
  }));
}

export function finalizePlanDevices(planDevices: DevicePlanDevice[]): {
  planDevices: DevicePlanDevice[];
  lastPlannedShedIds: Set<string>;
} {
  const sorted = sortByPriorityAsc(planDevices);
  const lastPlannedShedIds = new Set(sorted.filter((d) => d.plannedState === 'shed').map((d) => d.id));
  return { planDevices: sorted, lastPlannedShedIds };
}

type HoldDecision =
  | { type: 'skip' }
  | { type: 'restore'; availableHeadroom: number; restoredOneThisCycle: boolean }
  | { type: 'hold'; reason: string };

function hasTemperatureTarget(dev: DevicePlanDevice): boolean {
  return (typeof dev.currentTarget === 'number' && Number.isFinite(dev.currentTarget))
    || (typeof dev.plannedTarget === 'number' && Number.isFinite(dev.plannedTarget));
}

/* eslint-disable-next-line max-lines-per-function --
target restore admission mirrors binary restore checks and keeps decision/logging together */
function resolveRestoreDecision(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  structuredLog?: PinoLogger;
}): HoldDecision {
  const {
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    structuredLog,
  } = params;

  const setbackRemainingMs = getActivationRestoreBlockRemainingMs({ state, deviceId: dev.id });
  const phase = resolveRestoreDecisionPhase(state.currentRebuildReason);
  if (setbackRemainingMs !== null) {
    const reason = `activation backoff (${Math.max(1, Math.ceil(setbackRemainingMs / 1000))}s remaining)`;
    structuredLog?.debug({
      event: 'restore_rejected',
      restoreType: 'target',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      reason,
      availableKw: availableHeadroom,
      decision: 'rejected',
      decisionReason: reason,
      penaltyLevel: getActivationPenaltyLevel(state, dev.id),
    });
    return { type: 'hold', reason };
  }

  const restoreNeed = getRestoreNeed(dev, state);
  const admission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw: restoreNeed.needed });
  if (admission.postReserveMarginKw < RESTORE_ADMISSION_FLOOR_KW) {
    const reason = `insufficient headroom (need ${admission.requiredKw.toFixed(2)}kW, `
      + `headroom ${availableHeadroom.toFixed(2)}kW)`;
    structuredLog?.debug({
      event: 'restore_rejected',
      restoreType: 'target',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      reason,
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'rejected',
      decisionReason: reason,
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
    });
    return { type: 'hold', reason };
  }
  const gateReason = resolveCapacityRestoreBlockReason({
    timing: {
      activeOvershoot: false,
      inCooldown: false,
      inRestoreCooldown: false,
      inStartupStabilization: false,
      restoreCooldownSeconds,
      shedCooldownRemainingSec: null,
      restoreCooldownRemainingSec,
      startupStabilizationRemainingSec: null,
    },
    restoredOneThisCycle,
    useThrottleLabel: true,
  });
  if (gateReason) {
    structuredLog?.debug({
      event: 'restore_rejected',
      restoreType: 'target',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      reason: gateReason,
      estimatedPowerKw: restoreNeed.devPower,
      powerSource: resolveRestorePowerSource(dev),
      neededKw: restoreNeed.needed,
      availableKw: availableHeadroom,
      penaltyLevel: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyLevel : undefined,
      penaltyExtraKw: restoreNeed.penaltyLevel > 0 ? restoreNeed.penaltyExtraKw : undefined,
      ...buildRestoreAdmissionLogFields(admission),
      decision: 'rejected',
      decisionReason: gateReason,
    });
    return { type: 'hold', reason: gateReason };
  }
  restoredThisCycle.add(dev.id);
  const powerSource = resolveRestorePowerSource(dev);
  const logMethod = shouldLogRestoreAdmissionAtInfo({
    restoreType: 'target',
    marginKw: admission.marginKw,
    penaltyLevel: restoreNeed.penaltyLevel,
    powerSource,
    recentInstabilityMs: state.lastInstabilityMs,
  }) ? 'info' : 'debug';
  structuredLog?.[logMethod]({
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
  });
  return {
    type: 'restore',
    availableHeadroom: availableHeadroom - restoreNeed.needed,
    restoredOneThisCycle: true,
  };
}

function resolveHoldDecision(params: {
  dev: DevicePlanDevice;
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null };
  state: PlanEngineState;
  shedReasons: Map<string, string>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelaySec: number | null;
  structuredLog?: PinoLogger;
}): HoldDecision {
  const {
    dev,
    behavior,
    state,
    shedReasons,
    inShedWindow,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
    structuredLog,
  } = params;

  if (dev.controllable === false) {
    return { type: 'skip' };
  }

  if (behavior.action !== 'set_temperature' || behavior.temperature === null) {
    return { type: 'skip' };
  }
  if (!hasTemperatureTarget(dev)) {
    return { type: 'skip' };
  }

  const atMinTemp = Number(dev.currentTarget) === behavior.temperature
    || Number(dev.plannedTarget) === behavior.temperature;
  const alreadyMinTempShed = dev.shedAction === 'set_temperature' && dev.shedTemperature === behavior.temperature;
  const wasShedLastPlan = state.lastPlannedShedIds.has(dev.id);
  const shouldHold = (inShedWindow || holdDuringRestoreCooldown)
    && (dev.plannedState === 'shed' || atMinTemp || alreadyMinTempShed || wasShedLastPlan);

  if (!shouldHold && wasShedLastPlan) {
    return resolvePostHoldRestoreDecision({
      dev,
      state,
      availableHeadroom,
      restoredOneThisCycle,
      restoredThisCycle,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelaySec,
      structuredLog,
    });
  }

  if (!shouldHold) {
    return { type: 'skip' };
  }

  const baseReason = getBaseShedReason({
    dev,
    shedReasons,
  });
  return { type: 'hold', reason: baseReason };
}

function resolvePostHoldRestoreDecision(params: {
  dev: DevicePlanDevice;
  state: PlanEngineState;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelaySec: number | null;
  structuredLog?: PinoLogger;
}): HoldDecision {
  const {
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
    structuredLog,
  } = params;
  if (pendingRestoreDelaySec !== null) {
    return { type: 'hold', reason: `restore pending (${pendingRestoreDelaySec}s remaining)` };
  }
  return resolveRestoreDecision({
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    structuredLog,
  });
}

function applyHoldToDevice(params: {
  dev: DevicePlanDevice;
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null };
  state: PlanEngineState;
  shedReasons: Map<string, string>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelaySec: number | null;
  structuredLog?: PinoLogger;
}): { device: DevicePlanDevice; availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    behavior,
    state,
    shedReasons,
    inShedWindow,
    inCooldown,
    activeOvershoot,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    shedCooldownRemainingSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
    structuredLog,
  } = params;

  const decision = resolveHoldDecision({
    dev,
    behavior,
    state,
    shedReasons,
    inShedWindow,
    inCooldown,
    activeOvershoot,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    shedCooldownRemainingSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
    structuredLog,
  });

  if (decision.type === 'restore') {
    return {
      device: dev,
      availableHeadroom: decision.availableHeadroom,
      restoredOneThisCycle: decision.restoredOneThisCycle,
    };
  }
  if (decision.type === 'hold') {
    return applyHoldUpdate(dev, behavior, decision.reason, availableHeadroom, restoredOneThisCycle);
  }
  return { device: dev, availableHeadroom, restoredOneThisCycle };
}

function getPendingRestoreDelaySeconds(
  planDevices: DevicePlanDevice[],
  state: PlanEngineState,
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  },
): number | null {
  let maxRemainingMs = 0;
  const nowMs = Date.now();
  for (const dev of planDevices) {
    const behavior = getShedBehavior(dev.id);
    if (behavior.action !== 'set_temperature' || behavior.temperature === null) continue;
    if (typeof dev.currentTarget !== 'number' || dev.currentTarget !== behavior.temperature) continue;
    if (typeof dev.plannedTarget !== 'number' || dev.plannedTarget <= behavior.temperature) continue;

    const lastRestoreMs = state.lastDeviceRestoreMs[dev.id];
    if (!lastRestoreMs) continue;

    const elapsedMs = nowMs - lastRestoreMs;
    const remainingMs = RESTORE_CONFIRM_RETRY_MS - elapsedMs;
    if (remainingMs > maxRemainingMs) {
      maxRemainingMs = remainingMs;
    }
  }
  if (maxRemainingMs <= 0) return null;
  return Math.ceil(maxRemainingMs / 1000);
}

function normalizeDeviceReason(params: {
  dev: DevicePlanDevice;
  shedReasons: Map<string, string>;
  guardInShortfall: boolean;
  headroomRaw: number | null;
  inCooldown: boolean;
  activeOvershoot: boolean;
  inRestoreCooldown: boolean;
  shedCooldownRemainingSec: number | null;
  restoreCooldownRemainingSec: number | null;
}): DevicePlanDevice {
  const {
    dev,
    shedReasons,
    guardInShortfall,
    headroomRaw,
    inCooldown,
    activeOvershoot,
    inRestoreCooldown,
    shedCooldownRemainingSec,
    restoreCooldownRemainingSec,
  } = params;

  if (dev.plannedState !== 'shed') return dev;

  const reasonFlags = getReasonFlags(dev.reason);
  const baseReason = buildBaseReason(dev, shedReasons);

  const shortfallReason = maybeApplyShortfallReason({
    dev,
    guardInShortfall,
    reasonFlags,
    headroomRaw,
  });
  if (shortfallReason) return { ...dev, reason: shortfallReason };

  const cooldownReason = maybeApplyCooldownReason({
    reasonFlags,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
    inRestoreCooldown,
    restoreCooldownRemainingSec,
  });
  if (cooldownReason) return { ...dev, reason: cooldownReason };

  if (shouldNormalizeReason(dev.reason)) {
    return { ...dev, reason: baseReason };
  }
  return dev;
}

function applyHoldUpdate(
  dev: DevicePlanDevice,
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null },
  reason: string,
  availableHeadroom: number,
  restoredOneThisCycle: boolean,
): { device: DevicePlanDevice; availableHeadroom: number; restoredOneThisCycle: boolean } {
  return {
    device: {
      ...dev,
      plannedState: 'shed',
      shedAction: 'set_temperature',
      shedTemperature: behavior.temperature,
      plannedTarget: behavior.temperature,
      reason,
    },
    availableHeadroom,
    restoredOneThisCycle,
  };
}
