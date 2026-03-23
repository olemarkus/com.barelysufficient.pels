import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import type { PowerTrackerState } from '../core/powerTracker';
import {
  RECENT_SHED_EXTRA_BUFFER_KW,
  RECENT_SHED_RESTORE_BACKOFF_MS,
  RECENT_SHED_RESTORE_MULTIPLIER,
} from './planConstants';
import { SwapState, SwapStateSnapshot, buildSwapState, cleanupStaleSwaps, exportSwapState } from './planSwapState';
import {
  buildInsufficientHeadroomUpdate,
  buildSwapCandidates,
  computeBaseRestoreNeed,
  computeRestoreBufferKw,
} from './planRestoreSwap';
import {
  getInactiveReason,
  getOffDevices,
  getOnDevices,
  getSteppedRestoreCandidates,
  markOffDevicesStayOff,
} from './planRestoreDevices';
import {
  applyActivationPenalty,
  syncActivationPenaltyState,
} from './planActivationBackoff';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import { buildRestoreTiming, shouldPlanRestores, type RestoreTiming } from './planRestoreTiming';
import {
  getSteppedLoadNextRestoreStep,
  resolveSteppedLoadRestoreDeltaKw,
} from './planSteppedLoad';

export type RestoreDeps = {
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  };
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
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

    const steppedDevices = getSteppedRestoreCandidates(Array.from(deviceMap.values()));
    for (const dev of steppedDevices) {
      const result = planRestoreForSteppedDevice({
        dev,
        deviceMap,
        state,
        timing,
        availableHeadroom,
        restoredOneThisCycle,
      });
      availableHeadroom = result.availableHeadroom;
      restoredOneThisCycle = result.restoredOneThisCycle;
    }
  } else if (context.headroomRaw === null) {
    markOffDevicesStayOff({
      deviceMap,
      timing,
      logDebug: deps.logDebug,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
      reasonOverride: (dev) => {
        const { needed } = computeBaseRestoreNeed(dev);
        return `insufficient headroom (need ${needed.toFixed(2)}kW, headroom unknown)`;
      },
    });
  } else if (sheddingActive || timing.inCooldown || timing.inRestoreCooldown) {
    markOffDevicesStayOff({
      deviceMap,
      timing,
      logDebug: deps.logDebug,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
    });
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

function planRestoreForSteppedDevice(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  timing: Pick<RestoreTiming, 'restoreCooldownSeconds'>;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    deviceMap,
    state,
    timing,
    availableHeadroom,
    restoredOneThisCycle,
  } = params;

  if (restoredOneThisCycle) {
    setDevice(deviceMap, dev.id, {
      reason: `cooldown (restore, ${timing.restoreCooldownSeconds}s remaining)`,
    });
    return { availableHeadroom, restoredOneThisCycle };
  }

  if (hasOtherDevicesPendingRecovery(deviceMap, dev.id, state)) {
    setDevice(deviceMap, dev.id, {
      reason: 'waiting for other devices to recover',
    });
    return { availableHeadroom, restoredOneThisCycle };
  }

  const nextStep = getSteppedLoadNextRestoreStep(dev);
  if (!nextStep || !dev.selectedStepId) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  const deltaKw = resolveSteppedLoadRestoreDeltaKw({
    device: dev,
    fromStepId: dev.selectedStepId,
    toStepId: nextStep.id,
  });
  if (deltaKw <= 0) {
    return { availableHeadroom, restoredOneThisCycle };
  }

  const restoreBuffer = computeRestoreBufferKw(deltaKw);
  const needed = deltaKw + restoreBuffer;
  if (availableHeadroom < needed) {
    setDevice(deviceMap, dev.id, {
      reason: `insufficient headroom (need ${needed.toFixed(2)}kW, headroom ${availableHeadroom.toFixed(2)}kW)`,
    });
    return { availableHeadroom, restoredOneThisCycle };
  }

  setDevice(deviceMap, dev.id, {
    desiredStepId: nextStep.id,
    reason: `restore ${dev.selectedStepId} -> ${nextStep.id} (need ${needed.toFixed(2)}kW)`,
  });
  return {
    availableHeadroom: availableHeadroom - needed,
    restoredOneThisCycle: true,
  };
}

function planRestoreForDevice(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  state: PlanEngineState;
  timing: Pick<RestoreTiming, 'measurementTs' | 'restoreCooldownSeconds'>;
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

  const inactiveReason = getInactiveReason(dev);
  if (inactiveReason) {
    setDevice(deviceMap, dev.id, {
      plannedState: 'inactive',
      reason: inactiveReason,
    });
    deps.logDebug(`Plan: marking ${dev.name} inactive - ${inactiveReason}`);
    return { availableHeadroom, restoredOneThisCycle };
  }

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

  const restoreNeed = getRestoreNeed(dev, state, deps.deviceDiagnostics);
  if (availableHeadroom >= restoreNeed.needed) {
    restoredThisCycle.add(dev.id);
    return { availableHeadroom: availableHeadroom - restoreNeed.needed, restoredOneThisCycle: true };
  }

  const swapResult = attemptSwapRestore({
    dev,
    deviceMap,
    onDevices,
    swapState,
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
      logDebug(
        `Plan: blocking restore of ${dev.name} (p${devPriority}) - `
        + `swap target ${swapTargetDev.name} (p${swapTargetPriority}) should restore first`,
      );
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
  diagnostics?: DeviceDiagnosticsRecorder,
): { needed: number; devPower: number; penaltyLevel: number; penaltyExtraKw: number } {
  const { power: devPower, needed: baseNeeded } = computeBaseRestoreNeed(dev);
  const lastDeviceShed = state.lastDeviceShedMs[dev.id];
  const recentlyShed = Boolean(
    lastDeviceShed && Date.now() - lastDeviceShed < RECENT_SHED_RESTORE_BACKOFF_MS,
  );
  const recentShedNeeded = recentlyShed
    ? Math.max(baseNeeded * RECENT_SHED_RESTORE_MULTIPLIER, baseNeeded + RECENT_SHED_EXTRA_BUFFER_KW)
    : baseNeeded;
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId: dev.id,
    observation: {
      available: dev.available,
      currentState: dev.currentState,
      measuredPowerKw: dev.measuredPowerKw,
    },
  });
  for (const transition of penaltyInfo.transitions) {
    diagnostics?.recordActivationTransition(transition, { name: dev.name });
  }
  const penalty = applyActivationPenalty({
    baseRequiredKw: recentShedNeeded,
    penaltyLevel: penaltyInfo.penaltyLevel,
  });
  return {
    needed: penalty.requiredKwWithPenalty,
    devPower,
    penaltyLevel: penaltyInfo.penaltyLevel,
    penaltyExtraKw: penalty.penaltyExtraKw,
  };
}

function attemptSwapRestore(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  availableHeadroom: number;
  restoreNeed: { needed: number; devPower: number; penaltyLevel: number; penaltyExtraKw: number };
  measurementTs: number | null;
  restoredThisCycle: Set<string>;
  deps: RestoreDeps;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const {
    dev,
    deviceMap,
    onDevices,
    swapState,
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
    swappedOutFor: swapState.swappedOutFor,
    availableHeadroom,
    needed: restoreNeed.needed,
    restoredThisCycle,
  });
  if (!swap.ready) {
    const update = buildInsufficientHeadroomUpdate(restoreNeed.needed, availableHeadroom);
    setDevice(deviceMap, dev.id, update);
    deps.logDebug(
      `Plan: skipping restore of ${dev.name} `
      + `(p${dev.priority ?? 100}, ~${restoreNeed.devPower.toFixed(2)}kW) `
      + `- ${swap.reason}`
      + (restoreNeed.penaltyLevel > 0
        ? `, activation penalty L${restoreNeed.penaltyLevel} (+${restoreNeed.penaltyExtraKw.toFixed(2)}kW)`
        : ''),
    );
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
  const nextHeadroom = swap.potentialHeadroom;
  for (const shedDev of swap.toShed) {
    const shedPowerKw = getSwapShedPower(swap, shedDev.id, dev.id);
    setDevice(deviceMap, shedDev.id, {
      plannedState: 'shed',
      reason: `swapped out for ${dev.name}`,
    });
    deps.log(
      `Plan: swapping out ${shedDev.name} `
      + `(p${shedDev.priority ?? 100}, ~${shedPowerKw.toFixed(2)}kW) `
      + `to restore ${dev.name} (p${dev.priority ?? 100})`,
    );
    swapState.swappedOutFor.set(shedDev.id, dev.id);
  }
  restoredThisCycle.add(dev.id);
  setDevice(deviceMap, dev.id, { plannedState: 'keep' });
  return { availableHeadroom: nextHeadroom - restoreNeed.needed, restoredOneThisCycle: true };
}

function getSwapShedPower(
  swap: ReturnType<typeof buildSwapCandidates>,
  shedDeviceId: string,
  restoreDeviceId: string,
): number {
  const shedPowerKw = swap.shedPowerByDeviceId.get(shedDeviceId);
  if (shedPowerKw !== undefined) return shedPowerKw;
  throw new Error(
    `Plan: missing shed power entry for device ${shedDeviceId} while swapping to restore ${restoreDeviceId}`,
  );
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

function hasOtherDevicesPendingRecovery(
  deviceMap: Map<string, DevicePlanDevice>,
  steppedDeviceId: string,
  state: Pick<PlanEngineState, 'lastDeviceShedMs'>,
): boolean {
  for (const device of deviceMap.values()) {
    if (!shouldBlockSteppedRestoreForDevice(device, steppedDeviceId)) continue;
    if (isDevicePendingRecovery(device, state)) return true;
  }
  return false;
}

function shouldBlockSteppedRestoreForDevice(
  device: DevicePlanDevice,
  steppedDeviceId: string,
): boolean {
  return device.id !== steppedDeviceId
    && device.controllable !== false
    && !getInactiveReason(device);
}

function isDevicePendingRecovery(
  device: DevicePlanDevice,
  state: Pick<PlanEngineState, 'lastDeviceShedMs'>,
): boolean {
  if (device.plannedState === 'shed') return true;
  if (!state.lastDeviceShedMs[device.id] || device.plannedState !== 'keep') return false;
  return device.currentState === 'off'
    || device.currentState === 'unknown'
    || isTargetRestorePending(device);
}

function isTargetRestorePending(device: DevicePlanDevice): boolean {
  return device.shedAction === 'set_temperature'
    && typeof device.plannedTarget === 'number'
    && device.currentTarget !== device.plannedTarget
    && device.pendingTargetCommand?.desired === device.plannedTarget;
}
