import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeBaseRestoreNeed } from './planRestoreSwap';
import {
  buildBaseReason,
  getBaseShedReason,
  getReasonFlags,
  maybeApplyCooldownReason,
  maybeApplyShortfallReason,
  shouldNormalizeKeepReason as shouldNormalizeReason,
} from './planReasonHelpers';
import { sortByPriorityAsc } from './planSort';
import { RESTORE_CONFIRM_RETRY_MS } from './planConstants';
import { resolveCapacityRestoreBlockReason } from './planRestoreGate';

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

function resolveRestoreDecision(params: {
  dev: DevicePlanDevice;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
}): HoldDecision {
  const {
    dev,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
  } = params;
  const { buffer: restoreBuffer } = computeBaseRestoreNeed(dev);
  if (availableHeadroom < restoreBuffer) {
    const reason = `insufficient headroom (need ${restoreBuffer.toFixed(2)}kW, `
      + `headroom ${availableHeadroom.toFixed(2)}kW)`;
    return { type: 'hold', reason };
  }
  const gateReason = resolveCapacityRestoreBlockReason({
    timing: {
      activeOvershoot: false,
      inCooldown: false,
      inRestoreCooldown: false,
      restoreCooldownSeconds,
      shedCooldownRemainingSec: null,
      restoreCooldownRemainingSec,
    },
    restoredOneThisCycle,
    useThrottleLabel: true,
  });
  if (gateReason) {
    return { type: 'hold', reason: gateReason };
  }
  restoredThisCycle.add(dev.id);
  return {
    type: 'restore',
    availableHeadroom: availableHeadroom - restoreBuffer,
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
      availableHeadroom,
      restoredOneThisCycle,
      restoredThisCycle,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelaySec,
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
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelaySec: number | null;
}): HoldDecision {
  const {
    dev,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelaySec,
  } = params;
  if (pendingRestoreDelaySec !== null) {
    return { type: 'hold', reason: `restore pending (${pendingRestoreDelaySec}s remaining)` };
  }
  return resolveRestoreDecision({
    dev,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
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
