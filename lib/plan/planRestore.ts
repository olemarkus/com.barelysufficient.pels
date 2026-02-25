import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import type { PowerTrackerState } from '../core/powerTracker';
import {
  RECENT_SHED_EXTRA_BUFFER_KW,
  RECENT_SHED_RESTORE_BACKOFF_MS,
  RECENT_SHED_RESTORE_MULTIPLIER,
  RESTORE_COOLDOWN_MS,
  RESTORE_COOLDOWN_BACKOFF_MULTIPLIER,
  RESTORE_COOLDOWN_MAX_MS,
  RESTORE_STABLE_RESET_MS,
  SHED_COOLDOWN_MS,
} from './planConstants';
import { getShedCooldownState } from './planTiming';
import { sortByPriorityAsc, sortByPriorityDesc } from './planSort';
import {
  SwapState,
  SwapStateSnapshot,
  buildSwapState,
  cleanupStaleSwaps,
  exportSwapState,
} from './planSwapState';
import {
  buildInsufficientHeadroomUpdate,
  buildSwapCandidates,
  computeRestoreBufferKw,
  estimateRestorePower,
} from './planRestoreSwap';

export type RestoreDeps = {
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => { action: 'turn_off' | 'set_temperature'; temperature: number | null };
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};

export type RestorePlanState = SwapStateSnapshot;

export type RestorePlanResult = {
  planDevices: DevicePlanDevice[];
  stateUpdates: RestorePlanState;
  restoredThisCycle: Set<string>;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  activeOvershoot: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  restoreCooldownRemainingSec: number | null;
  inShedWindow: boolean;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
};

export function applyRestorePlan(params: {
  planDevices: DevicePlanDevice[];
  context: PlanContext;
  state: PlanEngineState;
  sheddingActive: boolean;
  deps: RestoreDeps;
}): RestorePlanResult {
  const { planDevices, context, state, sheddingActive, deps } = params;
  const deviceMap = new Map(planDevices.map((dev) => [dev.id, dev]));
  const swapState = buildSwapState(state);
  const timing = buildRestoreTiming(state, context.headroomRaw, deps.powerTracker);
  cleanupStaleSwaps(deviceMap, swapState, deps.log);

  const restoredThisCycle = new Set<string>();
  let availableHeadroom = context.headroomRaw !== null ? context.headroomRaw : 0;
  let restoredOneThisCycle = false;

  if (shouldPlanRestores(context.headroomRaw, sheddingActive, timing)) {
    const snapshot = Array.from(deviceMap.values());
    const offDevices = getOffDevices(snapshot);
    const onDevices = getOnDevices(snapshot, deps.getShedBehavior);
    for (const dev of offDevices) {
      const result = planRestoreForDevice({
        dev,
        deviceMap,
        onDevices,
        swapState,
        state,
        timing,
        availableHeadroom,
        restoredThisCycle,
        restoredOneThisCycle,
        deps,
      });
      availableHeadroom = result.availableHeadroom;
      restoredOneThisCycle = result.restoredOneThisCycle;
    }
  } else if (context.headroomRaw === null) {
    markOffDevicesStayOff(deviceMap, timing, deps.logDebug, (dev) => {
      const plannedPower = estimateRestorePower(dev);
      const restoreBuffer = computeRestoreBufferKw(plannedPower);
      const needed = plannedPower + restoreBuffer;
      return `insufficient headroom (need ${needed.toFixed(2)}kW, headroom unknown)`;
    });
  } else if (sheddingActive || timing.inCooldown || timing.inRestoreCooldown) {
    markOffDevicesStayOff(deviceMap, timing, deps.logDebug);
  }

  return {
    planDevices: Array.from(deviceMap.values()),
    stateUpdates: exportSwapState(swapState),
    restoredThisCycle,
    availableHeadroom,
    restoredOneThisCycle,
    ...timing,
  };
}

function buildRestoreTiming(
  state: PlanEngineState,
  headroomRaw: number | null,
  powerTracker: PowerTrackerState,
): {
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  activeOvershoot: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  restoreCooldownRemainingSec: number | null;
  inShedWindow: boolean;
  measurementTs: number | null;
  nowTs: number;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
} {
  const nowTs = Date.now();
  const measurementTs = powerTracker.lastTimestamp ?? null;
  const cooldownState = resolveRestoreCooldown(state, nowTs);
  const sinceRestore = state.lastRestoreMs ? nowTs - state.lastRestoreMs : null;
  const cooldown = getShedCooldownState({
    lastSheddingMs: state.lastSheddingMs,
    lastOvershootMs: state.lastOvershootMs,
    nowTs,
    cooldownMs: SHED_COOLDOWN_MS,
  });
  const cooldownRemainingMs = cooldown.cooldownRemainingMs;
  const inCooldown = cooldown.inCooldown;
  const inRestoreCooldown = sinceRestore !== null && sinceRestore < cooldownState.restoreCooldownMs;
  const activeOvershoot = headroomRaw !== null && headroomRaw < 0;
  const restoreCooldownSeconds = sinceRestore !== null
    ? Math.max(0, Math.ceil((cooldownState.restoreCooldownMs - sinceRestore) / 1000))
    : Math.ceil(cooldownState.restoreCooldownMs / 1000);
  const shedCooldownRemainingSec = cooldownRemainingMs !== null ? Math.ceil(cooldownRemainingMs / 1000) : null;
  const restoreCooldownRemainingMs = sinceRestore !== null
    ? Math.max(0, cooldownState.restoreCooldownMs - sinceRestore)
    : null;
  const restoreCooldownRemainingSec = restoreCooldownRemainingMs !== null ? Math.ceil(restoreCooldownRemainingMs / 1000) : null;
  const inShedWindow = inCooldown || activeOvershoot || inRestoreCooldown;

  return {
    inCooldown,
    inRestoreCooldown,
    activeOvershoot,
    restoreCooldownSeconds,
    shedCooldownRemainingSec,
    restoreCooldownRemainingSec,
    inShedWindow,
    measurementTs,
    nowTs,
    ...cooldownState,
  };
}

function resolveRestoreCooldown(
  state: PlanEngineState,
  nowTs: number,
): { restoreCooldownMs: number; lastRestoreCooldownBumpMs: number | null } {
  const lastRestoreMs = state.lastRestoreMs;
  const lastInstabilityMs = getLastInstabilityMs(state);
  const instabilityAgeMs = getInstabilityAgeMs(lastInstabilityMs, nowTs);

  let restoreCooldownMs = state.restoreCooldownMs ?? RESTORE_COOLDOWN_MS;
  let lastRestoreCooldownBumpMs = state.lastRestoreCooldownBumpMs ?? null;

  if (shouldResetRestoreCooldown(restoreCooldownMs, instabilityAgeMs)) {
    restoreCooldownMs = RESTORE_COOLDOWN_MS;
    lastRestoreCooldownBumpMs = lastInstabilityMs;
  }

  if (shouldBumpRestoreCooldown({
    lastRestoreMs,
    lastInstabilityMs,
    instabilityAgeMs,
    lastRestoreCooldownBumpMs,
  })) {
    restoreCooldownMs = Math.min(
      restoreCooldownMs * RESTORE_COOLDOWN_BACKOFF_MULTIPLIER,
      RESTORE_COOLDOWN_MAX_MS,
    );
    lastRestoreCooldownBumpMs = lastInstabilityMs;
  }

  return { restoreCooldownMs, lastRestoreCooldownBumpMs };
}

function getLastInstabilityMs(state: PlanEngineState): number {
  const lastSheddingMs = typeof state.lastSheddingMs === 'number' ? state.lastSheddingMs : 0;
  const lastOvershootMs = typeof state.lastOvershootMs === 'number' ? state.lastOvershootMs : 0;
  return Math.max(lastSheddingMs, lastOvershootMs);
}

function getInstabilityAgeMs(lastInstabilityMs: number, nowTs: number): number | null {
  if (lastInstabilityMs <= 0) return null;
  return nowTs - lastInstabilityMs;
}

function shouldResetRestoreCooldown(restoreCooldownMs: number, instabilityAgeMs: number | null): boolean {
  if (instabilityAgeMs === null) return false;
  if (restoreCooldownMs === RESTORE_COOLDOWN_MS) return false;
  return instabilityAgeMs >= RESTORE_STABLE_RESET_MS;
}

function shouldBumpRestoreCooldown(params: {
  lastRestoreMs: number | null;
  lastInstabilityMs: number;
  instabilityAgeMs: number | null;
  lastRestoreCooldownBumpMs: number | null;
}): boolean {
  const {
    lastRestoreMs,
    lastInstabilityMs,
    instabilityAgeMs,
    lastRestoreCooldownBumpMs,
  } = params;
  if (lastRestoreMs === null || lastInstabilityMs <= 0) return false;
  if (lastInstabilityMs <= lastRestoreMs) return false;
  if (instabilityAgeMs === null || instabilityAgeMs >= RESTORE_STABLE_RESET_MS) return false;
  if (lastRestoreCooldownBumpMs !== null && lastRestoreCooldownBumpMs >= lastInstabilityMs) return false;
  return true;
}

function shouldPlanRestores(
  headroomRaw: number | null,
  sheddingActive: boolean,
  timing: { inCooldown: boolean; inRestoreCooldown: boolean },
): boolean {
  return headroomRaw !== null && !sheddingActive && !timing.inCooldown && !timing.inRestoreCooldown;
}

function getOffDevices(planDevices: DevicePlanDevice[]): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((d) => d.controllable !== false && d.currentState === 'off' && d.plannedState !== 'shed');
  return sortByPriorityAsc(filtered);
}

function getOnDevices(
  planDevices: DevicePlanDevice[],
  getShedBehavior: (deviceId: string) => { action: 'turn_off' | 'set_temperature'; temperature: number | null },
): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((d) => d.controllable !== false && d.plannedState !== 'shed')
    .filter((d) => d.currentState === 'on' || d.currentState === 'not_applicable')
    .filter((d) => canSwapOutDevice(d, getShedBehavior(d.id)));
  return sortByPriorityDesc(filtered);
}

function canSwapOutDevice(
  dev: DevicePlanDevice,
  behavior: { action: 'turn_off' | 'set_temperature'; temperature: number | null },
): boolean {
  if (behavior.action !== 'set_temperature' || behavior.temperature === null) return true;
  let currentTarget: number | null = null;
  if (typeof dev.currentTarget === 'number') {
    currentTarget = dev.currentTarget;
  } else if (typeof dev.plannedTarget === 'number') {
    currentTarget = dev.plannedTarget;
  }
  if (currentTarget === null) return true;
  return currentTarget > behavior.temperature;
}

function planRestoreForDevice(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  state: PlanEngineState;
  timing: {
    measurementTs: number | null;
    restoreCooldownSeconds: number;
  };
  availableHeadroom: number;
  restoredThisCycle: Set<string>;
  restoredOneThisCycle: boolean;
  deps: RestoreDeps;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    deviceMap,
    onDevices,
    swapState,
    state,
    timing,
    availableHeadroom,
    restoredThisCycle,
    restoredOneThisCycle,
    deps,
  } = params;

  if (restoredOneThisCycle) {
    setDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: `cooldown (restore, ${timing.restoreCooldownSeconds}s remaining)`,
    });
    return { availableHeadroom, restoredOneThisCycle };
  }

  const swapBlock = shouldBlockRestoreForSwap(dev, deviceMap, swapState, deps.logDebug);
  if (swapBlock) return { availableHeadroom, restoredOneThisCycle };

  const pendingBlock = shouldBlockRestoreForPendingSwap(dev, deviceMap, swapState, deps.logDebug);
  if (pendingBlock) return { availableHeadroom, restoredOneThisCycle };

  const restoreNeed = getRestoreNeed(dev, state);
  if (availableHeadroom >= restoreNeed.needed) {
    restoredThisCycle.add(dev.id);
    return { availableHeadroom: availableHeadroom - restoreNeed.needed, restoredOneThisCycle: true };
  }

  const swapResult = attemptSwapRestore({
    dev,
    deviceMap,
    onDevices,
    swapState,
    state,
    availableHeadroom,
    restoreNeed,
    measurementTs: timing.measurementTs,
    restoredThisCycle,
    deps,
  });
  return {
    availableHeadroom: swapResult.availableHeadroom,
    restoredOneThisCycle: swapResult.restoredOneThisCycle,
  };
}

function shouldBlockRestoreForSwap(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
  logDebug: (...args: unknown[]) => void,
): boolean {
  const swappedFor = swapState.swappedOutFor.get(dev.id);
  if (!swappedFor) return false;
  const higherPriDev = deviceMap.get(swappedFor);
  if (higherPriDev && higherPriDev.currentState === 'off') {
    setDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: `swap pending (${higherPriDev.name})`,
    });
    logDebug(`Plan: blocking restore of ${dev.name} - was swapped out for ${higherPriDev.name} which is still off`);
    return true;
  }
  swapState.swappedOutFor.delete(dev.id);
  swapState.pendingSwapTargets.delete(swappedFor);
  swapState.pendingSwapTimestamps.delete(swappedFor);
  logDebug(`Plan: ${dev.name} can now be considered for restore - ${higherPriDev?.name ?? swappedFor} is restored`);
  return false;
}

function shouldBlockRestoreForPendingSwap(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
  logDebug: (...args: unknown[]) => void,
): boolean {
  if (swapState.pendingSwapTargets.size === 0 || swapState.pendingSwapTargets.has(dev.id)) return false;
  const devPriority = dev.priority ?? 100;
  for (const swapTargetId of swapState.pendingSwapTargets) {
    if (swapTargetId === dev.id) continue;
    const swapTargetDev = deviceMap.get(swapTargetId);
    if (!swapTargetDev) {
      swapState.pendingSwapTargets.delete(swapTargetId);
      swapState.pendingSwapTimestamps.delete(swapTargetId);
      continue;
    }
    const swapTargetPriority = swapTargetDev.priority ?? 100;
    if (swapTargetPriority >= devPriority && swapTargetDev.currentState === 'off') {
      setDevice(deviceMap, dev.id, {
        plannedState: 'shed',
        reason: `swap pending (${swapTargetDev.name})`,
      });
      logDebug(`Plan: blocking restore of ${dev.name} (p${devPriority}) - swap target ${swapTargetDev.name} (p${swapTargetPriority}) should restore first`);
      return true;
    }
    if (swapTargetDev.currentState === 'on') {
      swapState.pendingSwapTargets.delete(swapTargetId);
      swapState.pendingSwapTimestamps.delete(swapTargetId);
    }
  }
  return false;
}

function getRestoreNeed(
  dev: DevicePlanDevice,
  state: PlanEngineState,
): { needed: number; devPower: number } {
  const devPower = estimateRestorePower(dev);
  const restoreBuffer = computeRestoreBufferKw(devPower);
  const baseNeeded = devPower + restoreBuffer;
  const lastDeviceShed = state.lastDeviceShedMs[dev.id];
  const recentlyShed = Boolean(
    lastDeviceShed && Date.now() - lastDeviceShed < RECENT_SHED_RESTORE_BACKOFF_MS,
  );
  const needed = recentlyShed
    ? Math.max(baseNeeded * RECENT_SHED_RESTORE_MULTIPLIER, baseNeeded + RECENT_SHED_EXTRA_BUFFER_KW)
    : baseNeeded;
  return { needed, devPower };
}

function attemptSwapRestore(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  state: PlanEngineState;
  availableHeadroom: number;
  restoreNeed: { needed: number; devPower: number };
  measurementTs: number | null;
  restoredThisCycle: Set<string>;
  deps: RestoreDeps;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    deviceMap,
    onDevices,
    swapState,
    state,
    availableHeadroom,
    restoreNeed,
    measurementTs,
    restoredThisCycle,
    deps,
  } = params;

  if (measurementTs !== null && swapState.lastSwapPlanMeasurementTs.get(dev.id) === measurementTs) {
    setDevice(deviceMap, dev.id, { plannedState: 'shed', reason: 'swap pending' });
    deps.logDebug(`Plan: skipping ${dev.name} - waiting for new measurement before swap`);
    return { availableHeadroom, restoredOneThisCycle: false };
  }

  if (swapState.pendingSwapTargets.has(dev.id)) {
    setDevice(deviceMap, dev.id, { plannedState: 'shed', reason: 'swap pending' });
    deps.logDebug(`Plan: skipping ${dev.name} - swap already pending`);
    return { availableHeadroom, restoredOneThisCycle: false };
  }

  const swap = buildSwapCandidates({
    dev,
    onDevices,
    state,
    availableHeadroom,
    needed: restoreNeed.needed,
    restoredThisCycle,
  });
  if (!swap.ready) {
    const update = buildInsufficientHeadroomUpdate(restoreNeed.needed, availableHeadroom);
    setDevice(deviceMap, dev.id, update);
    deps.logDebug(`Plan: skipping restore of ${dev.name} (p${dev.priority ?? 100}, ~${restoreNeed.devPower.toFixed(2)}kW) - ${swap.reason}`);
    return { availableHeadroom, restoredOneThisCycle: false };
  }

  deps.log(
    `Plan: swap approved for ${dev.name} - shedding ${swap.shedNames} (${swap.shedPower}kW) `
    + `to get ${swap.potentialHeadroom.toFixed(2)}kW >= ${restoreNeed.needed.toFixed(2)}kW needed`,
  );
  swapState.pendingSwapTargets.add(dev.id);
  swapState.pendingSwapTimestamps.set(dev.id, Date.now());
  if (measurementTs !== null) {
    swapState.lastSwapPlanMeasurementTs.set(dev.id, measurementTs);
  }
  let nextHeadroom = swap.availableHeadroom;
  for (const shedDev of swap.toShed) {
    setDevice(deviceMap, shedDev.id, {
      plannedState: 'shed',
      reason: `swapped out for ${dev.name}`,
    });
    deps.log(`Plan: swapping out ${shedDev.name} (p${shedDev.priority ?? 100}, ~${(shedDev.powerKw ?? 1).toFixed(2)}kW) to restore ${dev.name} (p${dev.priority ?? 100})`);
    nextHeadroom += shedDev.powerKw && shedDev.powerKw > 0 ? shedDev.powerKw : 1;
    swapState.swappedOutFor.set(shedDev.id, dev.id);
  }
  restoredThisCycle.add(dev.id);
  setDevice(deviceMap, dev.id, { plannedState: 'keep' });
  return { availableHeadroom: nextHeadroom - restoreNeed.needed, restoredOneThisCycle: true };
}

function markOffDevicesStayOff(
  deviceMap: Map<string, DevicePlanDevice>,
  timing: { activeOvershoot: boolean; inCooldown: boolean; restoreCooldownSeconds: number; shedCooldownRemainingSec: number | null },
  logDebug: (...args: unknown[]) => void,
  reasonOverride?: (dev: DevicePlanDevice) => string,
): void {
  const offDevices = Array.from(deviceMap.values())
    .filter((d) => d.controllable !== false && d.currentState === 'off' && d.plannedState !== 'shed');
  for (const dev of offDevices) {
    const defaultReason = dev.reason || 'shed due to capacity';
    const nextReason = reasonOverride ? reasonOverride(dev) : resolveOffDeviceReason(timing, defaultReason);
    setDevice(deviceMap, dev.id, { plannedState: 'shed', reason: nextReason });
    logDebug(`Plan: skipping restore of ${dev.name} (p${dev.priority ?? 100}, ~${(dev.powerKw ?? 1).toFixed(2)}kW) - ${nextReason}`);
  }
}

function resolveOffDeviceReason(
  timing: { activeOvershoot: boolean; inCooldown: boolean; restoreCooldownSeconds: number; shedCooldownRemainingSec: number | null },
  defaultReason: string,
): string {
  if (timing.activeOvershoot) return defaultReason;
  if (timing.inCooldown) {
    const seconds = timing.shedCooldownRemainingSec ?? 0;
    return `cooldown (shedding, ${seconds}s remaining)`;
  }
  return `cooldown (restore, ${timing.restoreCooldownSeconds}s remaining)`;
}

function setDevice(
  deviceMap: Map<string, DevicePlanDevice>,
  id: string,
  updates: Partial<DevicePlanDevice>,
): void {
  const current = deviceMap.get(id);
  if (!current) return;
  deviceMap.set(id, { ...current, ...updates });
}
