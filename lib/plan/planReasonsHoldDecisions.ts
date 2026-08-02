import type { DevicePlanDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { PlanEngineState } from './planState';
import type { HeadroomReserve } from './admission';
import type { RestoreHeadroomLedger } from './restore/headroomLedger';
import type { StructuredDebugEmitter } from '../logging/logger';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import {
  classifyPlanReason,
  renderPlanReasonDecision,
  type PlanReasonDecision,
} from './planReasonStrings';
import { isBudgetReason, isShortfallReason, isSwapReason } from './planReasonsShared';
import { RESTORE_CONFIRM_RETRY_MS } from './planConstants';
import { NEUTRAL_STARTUP_HOLD_REASON } from './restore/devices';
import { resolveRestoreDecision, type HoldDecision } from './planReasonsRestoreGating';

type PendingRestoreDelay = {
  remainingSec: number;
  countdownStartedAtMs: number;
  countdownTotalSec: number;
};

function getBaseShedReason(params: {
  dev: DevicePlanDevice;
  shedReasons: Map<string, DeviceReason>;
}): PlanReasonDecision {
  const { dev, shedReasons } = params;
  const explicitReason = shedReasons.get(dev.id);
  if (explicitReason) return { code: 'existing', reason: explicitReason };

  const classifiedReason = classifyPlanReason(dev.reason);
  if (
    classifiedReason.reason
    && (isShortfallReason(classifiedReason) || isSwapReason(classifiedReason) || isBudgetReason(classifiedReason))
  ) {
    return { code: 'existing', reason: classifiedReason.reason };
  }

  return { code: 'existing', reason: { code: PLAN_REASON_CODES.capacity, detail: null } };
}

export type ShedHoldParams = {
  planDevices: DevicePlanDevice[];
  state: PlanEngineState;
  shedReasons: Map<string, DeviceReason>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  // Per-axis ledger carried over from the restore pass: a budget-exempt
  // setpoint-shed device admits its raise against the CAPACITY axis, exactly
  // like the binary/stepped lanes. Optional so scalar-only callers/tests keep
  // the single-track behavior.
  ledger?: RestoreHeadroomLedger;
  // This cycle's startup reservations, resolved once by the restore pass. A
  // setpoint-shed restore admits against them exactly like the binary/stepped
  // lanes (`restore/gating.ts`) — a raise into a reserved block is PELS giving
  // the promised power away. Optional so scalar-only callers/tests opt out.
  headroomReserves?: readonly HeadroomReserve[];
  guardInShortfall?: boolean;
  debugStructured?: StructuredDebugEmitter;
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
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    ledger,
    headroomReserves,
    guardInShortfall = false,
    debugStructured,
    getShedBehavior,
  } = params;

  let headroom = availableHeadroom;
  let restoredOne = restoredOneThisCycle;
  const nextDevices: DevicePlanDevice[] = [];
  const pendingRestoreDelay = getPendingRestoreDelay(planDevices, state, getShedBehavior);

  for (const dev of planDevices) {
    const behavior = getShedBehavior(dev.id);
    const availableForDevice = ledger ? ledger.availableFor(dev) : headroom;
    const result = applyHoldToDevice({
      dev,
      behavior,
      state,
      shedReasons,
      inShedWindow,
      inCooldown,
      activeOvershoot,
      availableHeadroom: availableForDevice,
      restoredOneThisCycle: restoredOne,
      restoredThisCycle,
      shedCooldownRemainingSec,
      shedCooldownStartedAtMs,
      shedCooldownTotalSec,
      holdDuringRestoreCooldown,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelay,
      headroomReserves,
      guardInShortfall,
      debugStructured,
    });
    if (ledger) {
      ledger.commit(dev, availableForDevice - result.availableHeadroom);
      headroom = ledger.summaryAvailableKw();
    } else {
      headroom = result.availableHeadroom;
    }
    restoredOne = result.restoredOneThisCycle;
    nextDevices.push(result.device);
  }

  return {
    planDevices: nextDevices,
    availableHeadroom: headroom,
    restoredOneThisCycle: restoredOne,
  };
}

function hasTemperatureTarget(dev: DevicePlanDevice): boolean {
  if (!isTemperaturePlanDevice(dev)) return false;
  const { currentTarget, plannedTarget } = dev;
  return (typeof currentTarget === 'number' && Number.isFinite(currentTarget))
    || (typeof plannedTarget === 'number' && Number.isFinite(plannedTarget));
}

function resolveHoldGating(params: {
  dev: DevicePlanDevice;
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null };
  state: PlanEngineState;
  inShedWindow: boolean;
  holdDuringRestoreCooldown: boolean;
  guardInShortfall: boolean;
}): { shouldAbortRestoreForShortfall: boolean; shouldHold: boolean; wasShedLastPlan: boolean } {
  const { dev, behavior, state, inShedWindow, holdDuringRestoreCooldown, guardInShortfall } = params;
  const isTemperature = isTemperaturePlanDevice(dev);
  const currentTarget = isTemperature ? dev.currentTarget : null;
  const plannedTarget = isTemperature ? dev.plannedTarget : undefined;
  const atMinTemp = Number(currentTarget) === behavior.temperature
    || Number(plannedTarget) === behavior.temperature;
  const alreadyMinTempShed = dev.shedAction === 'set_temperature' && dev.shedTemperature === behavior.temperature;
  const wasShedLastPlan = state.lastPlannedShedIds.has(dev.id);
  const eligible = dev.plannedState === 'shed' || atMinTemp || alreadyMinTempShed || wasShedLastPlan;
  const shouldAbortRestoreForShortfall = guardInShortfall && eligible;
  const shouldHold = (inShedWindow || holdDuringRestoreCooldown) && eligible;
  return { shouldAbortRestoreForShortfall, shouldHold, wasShedLastPlan };
}

function resolveHoldDecision(params: {
  dev: DevicePlanDevice;
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null };
  state: PlanEngineState;
  shedReasons: Map<string, DeviceReason>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelay: PendingRestoreDelay | null;
  headroomReserves?: readonly HeadroomReserve[];
  guardInShortfall: boolean;
  debugStructured?: StructuredDebugEmitter;
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
    pendingRestoreDelay,
    headroomReserves,
    guardInShortfall,
    debugStructured,
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

  const { shouldAbortRestoreForShortfall, shouldHold, wasShedLastPlan } = resolveHoldGating({
    dev,
    behavior,
    state,
    inShedWindow,
    holdDuringRestoreCooldown,
    guardInShortfall,
  });

  if (!shouldAbortRestoreForShortfall && !shouldHold && wasShedLastPlan) {
    // "Observed at the shed floor" means the DEVICE reports the floor target —
    // not the plan's own `plannedTarget`, which the hold writes back each
    // cycle. Until the floor is observed, a reserve block must keep asserting
    // the original shed (an actuating reason) rather than the no-actuation
    // `reservedForStart` hold, or the pending floor command stops being
    // retried and the device keeps drawing inside the reserved block.
    const observedAtShedFloor = isTemperaturePlanDevice(dev)
      && typeof dev.currentTarget === 'number'
      && dev.currentTarget === behavior.temperature;
    return resolvePostHoldRestoreDecision({
      dev,
      state,
      availableHeadroom,
      restoredOneThisCycle,
      restoredThisCycle,
      restoreCooldownSeconds,
      restoreCooldownRemainingSec,
      pendingRestoreDelay,
      headroomReserves,
      observedAtShedFloor,
      baseShedReason: getBaseShedReason({ dev, shedReasons }),
      debugStructured,
    });
  }

  if (!shouldAbortRestoreForShortfall && !shouldHold) {
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
  pendingRestoreDelay: PendingRestoreDelay | null;
  headroomReserves?: readonly HeadroomReserve[];
  observedAtShedFloor?: boolean;
  baseShedReason?: PlanReasonDecision;
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
    pendingRestoreDelay,
    headroomReserves,
    observedAtShedFloor,
    baseShedReason,
    debugStructured,
  } = params;
  if (pendingRestoreDelay !== null) {
    return {
      type: 'hold',
      reason: {
        code: 'restore_pending',
        remainingSec: pendingRestoreDelay.remainingSec,
        countdownTiming: {
          countdownStartedAtMs: pendingRestoreDelay.countdownStartedAtMs,
          countdownTotalSec: pendingRestoreDelay.countdownTotalSec,
        },
      },
    };
  }
  return resolveRestoreDecision({
    dev,
    state,
    availableHeadroom,
    restoredOneThisCycle,
    restoredThisCycle,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    headroomReserves,
    observedAtShedFloor,
    baseShedReason,
    debugStructured,
  });
}

function applyHoldToDevice(params: {
  dev: DevicePlanDevice;
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null };
  state: PlanEngineState;
  shedReasons: Map<string, DeviceReason>;
  inShedWindow: boolean;
  inCooldown: boolean;
  activeOvershoot: boolean;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
  holdDuringRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  restoreCooldownRemainingSec: number | null;
  pendingRestoreDelay: PendingRestoreDelay | null;
  headroomReserves?: readonly HeadroomReserve[];
  guardInShortfall: boolean;
  debugStructured?: StructuredDebugEmitter;
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
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelay,
    headroomReserves,
    guardInShortfall,
    debugStructured,
  } = params;

  if (dev.plannedState === 'shed' && dev.reason.code === NEUTRAL_STARTUP_HOLD_REASON.code) {
    return { device: dev, availableHeadroom, restoredOneThisCycle };
  }

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
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
    holdDuringRestoreCooldown,
    restoreCooldownSeconds,
    restoreCooldownRemainingSec,
    pendingRestoreDelay,
    headroomReserves,
    guardInShortfall,
    debugStructured,
  });

  if (decision.type === 'restore') {
    return {
      device: dev,
      availableHeadroom: decision.availableHeadroom,
      restoredOneThisCycle: decision.restoredOneThisCycle,
    };
  }
  if (decision.type === 'hold') {
    return applyHoldUpdate(
      dev,
      behavior,
      renderPlanReasonDecision(decision.reason),
      availableHeadroom,
      restoredOneThisCycle,
    );
  }
  return { device: dev, availableHeadroom, restoredOneThisCycle };
}

function getPendingRestoreDelay(
  planDevices: DevicePlanDevice[],
  state: PlanEngineState,
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  },
): PendingRestoreDelay | null {
  let maxRemainingMs = 0;
  let countdownStartedAtMs: number | null = null;
  const nowMs = Date.now();
  for (const dev of planDevices) {
    const behavior = getShedBehavior(dev.id);
    if (behavior.action !== 'set_temperature' || behavior.temperature === null) continue;
    if (!isTemperaturePlanDevice(dev)) continue;
    const { currentTarget, plannedTarget } = dev;
    if (typeof currentTarget !== 'number' || currentTarget !== behavior.temperature) continue;
    if (typeof plannedTarget !== 'number' || plannedTarget <= behavior.temperature) continue;

    const lastRestoreMs = state.lastDeviceRestoreMs[dev.id];
    if (!lastRestoreMs) continue;

    const elapsedMs = nowMs - lastRestoreMs;
    const remainingMs = RESTORE_CONFIRM_RETRY_MS - elapsedMs;
    if (remainingMs > maxRemainingMs) {
      maxRemainingMs = remainingMs;
      countdownStartedAtMs = lastRestoreMs;
    }
  }
  if (maxRemainingMs <= 0 || countdownStartedAtMs === null) return null;
  return {
    remainingSec: Math.ceil(maxRemainingMs / 1000),
    countdownStartedAtMs,
    countdownTotalSec: Math.ceil(RESTORE_CONFIRM_RETRY_MS / 1000),
  };
}

function applyHoldUpdate(
  dev: DevicePlanDevice,
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null },
  reason: DeviceReason,
  availableHeadroom: number,
  restoredOneThisCycle: boolean,
): { device: DevicePlanDevice; availableHeadroom: number; restoredOneThisCycle: boolean } {
  return {
    device: {
      ...dev,
      plannedState: 'shed',
      shedAction: 'set_temperature',
      shedTemperature: behavior.temperature,
      ...(behavior.temperature !== null ? { plannedTarget: behavior.temperature } : {}),
      reason,
    },
    availableHeadroom,
    restoredOneThisCycle,
  };
}
