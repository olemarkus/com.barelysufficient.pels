import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeRestoreBufferKw, estimateRestorePower } from './planRestoreSwap';
import { sortByPriorityAsc } from './planSort';

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
  getShedBehavior: (deviceId: string) => { action: 'turn_off' | 'set_temperature'; temperature: number | null };
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
    getShedBehavior,
  } = params;

  let headroom = availableHeadroom;
  let restoredOne = restoredOneThisCycle;
  let nextDevices: DevicePlanDevice[] = [];

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
    });
    headroom = result.availableHeadroom;
    restoredOne = result.restoredOneThisCycle;
    nextDevices = [...nextDevices, result.device];
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

function shouldNormalizeReason(reason: string | undefined): boolean {
  if (!reason) return true;
  return reason === 'keep'
    || reason.startsWith('keep (')
    || reason.startsWith('restore (need')
    || reason.startsWith('set to ');
}

function getBaseShedReason(
  dev: DevicePlanDevice,
  shedReasons: Map<string, string>,
  activeOvershoot: boolean,
  inCooldown: boolean,
  shedCooldownRemainingSec: number | null,
): string {
  const isSwapReason = typeof dev.reason === 'string'
    && (dev.reason.includes('swapped out') || dev.reason.includes('swap pending'));
  const hasSpecialReason = typeof dev.reason === 'string'
    && (dev.reason.includes('shortfall')
      || isSwapReason
      || dev.reason.includes('hourly budget')
      || dev.reason.includes('daily budget'));
  const baseReason = shedReasons.get(dev.id)
    || (hasSpecialReason && dev.reason)
    || 'shed due to capacity';
  if (inCooldown && !activeOvershoot && !dev.reason?.includes('swap')) {
    return `cooldown (shedding, ${shedCooldownRemainingSec ?? 0}s remaining)`;
  }
  return baseReason;
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
}): HoldDecision {
  const {
    dev,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
  } = params;
  const restoreBuffer = computeRestoreBufferKw(estimateRestorePower(dev));
  if (availableHeadroom < restoreBuffer) {
    const reason = `insufficient headroom (need ${restoreBuffer.toFixed(2)}kW, headroom ${availableHeadroom.toFixed(2)}kW)`;
    return { type: 'hold', reason };
  }
  if (restoredOneThisCycle) {
    return { type: 'hold', reason: 'restore throttled' };
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
  behavior: { action: 'turn_off' | 'set_temperature'; temperature: number | null };
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
}): HoldDecision {
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

  const atMinTemp = Number(dev.currentTarget) === behavior.temperature || Number(dev.plannedTarget) === behavior.temperature;
  const alreadyMinTempShed = dev.shedAction === 'set_temperature' && dev.shedTemperature === behavior.temperature;
  const wasShedLastPlan = state.lastPlannedShedIds.has(dev.id);
  const shouldHold = (inShedWindow || holdDuringRestoreCooldown)
    && (dev.plannedState === 'shed' || atMinTemp || alreadyMinTempShed || wasShedLastPlan);

  if (!shouldHold && wasShedLastPlan) {
    return resolveRestoreDecision({
      dev,
      availableHeadroom,
      restoredOneThisCycle,
      restoredThisCycle,
    });
  }

  if (!shouldHold) {
    return { type: 'skip' };
  }

  const baseReason = getBaseShedReason(dev, shedReasons, activeOvershoot, inCooldown, shedCooldownRemainingSec);
  return { type: 'hold', reason: baseReason };
}

function applyHoldToDevice(params: {
  dev: DevicePlanDevice;
  behavior: { action: 'turn_off' | 'set_temperature'; temperature: number | null };
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
  behavior: { action: 'turn_off' | 'set_temperature'; temperature: number | null },
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

function getReasonFlags(reason: string | undefined): {
  isSwapReason: boolean;
  isBudgetReason: boolean;
  isShortfallReason: boolean;
} {
  return {
    isSwapReason: Boolean(reason && (reason.includes('swap pending') || reason.includes('swapped out'))),
    isBudgetReason: Boolean(reason && (reason.includes('hourly budget') || reason.includes('daily budget'))),
    isShortfallReason: Boolean(reason && reason.includes('shortfall')),
  };
}

function buildBaseReason(
  dev: DevicePlanDevice,
  shedReasons: Map<string, string>,
): string {
  const keepReason = dev.reason
    && dev.reason !== 'keep'
    && !dev.reason.startsWith('keep (')
    && !dev.reason.startsWith('restore (need')
    && !dev.reason.startsWith('set to ')
    ? dev.reason
    : null;
  return shedReasons.get(dev.id) || keepReason || 'shed due to capacity';
}

function maybeApplyShortfallReason(params: {
  dev: DevicePlanDevice;
  guardInShortfall: boolean;
  reasonFlags: { isSwapReason: boolean; isBudgetReason: boolean; isShortfallReason: boolean };
  headroomRaw: number | null;
}): string | null {
  const { dev, guardInShortfall, reasonFlags, headroomRaw } = params;
  if (!guardInShortfall || reasonFlags.isSwapReason || reasonFlags.isBudgetReason) return null;
  if (dev.reason?.startsWith('shortfall (')) return null;
  const estimatedPower = estimateRestorePower(dev);
  const restoreBuffer = computeRestoreBufferKw(estimatedPower);
  const estimatedNeed = estimatedPower + restoreBuffer;
  return `shortfall (need ${estimatedNeed.toFixed(2)}kW, headroom ${headroomRaw === null ? 'unknown' : headroomRaw.toFixed(2)}kW)`;
}

function maybeApplyCooldownReason(params: {
  reasonFlags: { isSwapReason: boolean; isBudgetReason: boolean; isShortfallReason: boolean };
  inCooldown: boolean;
  activeOvershoot: boolean;
  shedCooldownRemainingSec: number | null;
  inRestoreCooldown: boolean;
  restoreCooldownRemainingSec: number | null;
}): string | null {
  const {
    reasonFlags,
    inCooldown,
    activeOvershoot,
    shedCooldownRemainingSec,
    inRestoreCooldown,
    restoreCooldownRemainingSec,
  } = params;
  if (inCooldown && !activeOvershoot && !reasonFlags.isSwapReason) {
    return `cooldown (shedding, ${shedCooldownRemainingSec ?? 0}s remaining)`;
  }
    if (inRestoreCooldown && !activeOvershoot && !reasonFlags.isSwapReason && !reasonFlags.isBudgetReason && !reasonFlags.isShortfallReason) {
    return `cooldown (restore, ${restoreCooldownRemainingSec ?? 0}s remaining)`;
  }
  return null;
}
