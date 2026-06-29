import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import type { PlanContext } from '../planContext';
import {
  buildSwapState,
  cleanupCompletedSwaps,
  cleanupStaleSwaps,
  exportSwapState,
  type SwapState,
} from '../swap';
import {
  getOnDevices,
  getRestoreCandidates,
  getSteppedRestoreCandidates,
  isActiveSteppedRestoreCandidate,
  isBinaryRestoreCandidate,
  isOffSteppedRestoreCandidate,
  markOffDevicesStayOff,
  type RestoreCandidate,
} from './devices';
import {
  markSteppedDevicesStayAtCurrentLevel,
  planRestoreForSteppedDevice,
  setRestorePlanDevice as setDevice,
  type SteppedSwapExecutor,
} from './helpers';
import {
  buildRestoreTiming,
  resolveMeterSettlingRemainingSec,
  shouldPlanRestores,
  type RestoreTiming,
} from './timing';
import { resolveRestoreDecisionPhase } from '../admission';
import { reserveHeadroomForPendingRestores } from './support';
import { attemptSwapRestore, holdPendingSwapTargetUntilSourcesAreOff } from './swap';
import { buildRestoreBatchState } from './batch';
import { planRestoreForDevice } from './gating';
import { markOffDevicesMeterSettling, markRestoreCandidatesStayShedForShortfall } from './marking';
import type { RestoreBatchState, RestoreDeps, RestoreLoopState, RestorePlanResult } from './types';

export type { RestoreDeps, RestorePlanState, RestorePlanResult } from './types';

export function applyRestorePlan(params: {
  planDevices: DevicePlanDevice[];
  context: PlanContext;
  state: PlanEngineState;
  sheddingActive: boolean;
  guardInShortfall?: boolean;
  deps: RestoreDeps;
}): RestorePlanResult {
  const { planDevices, context, state, sheddingActive, guardInShortfall = false, deps } = params;
  const deviceMap = new Map(planDevices.map((dev) => [dev.id, dev]));
  const swapState = buildSwapState(state);
  const timing = buildRestoreTiming(state, context.headroomRaw, deps.powerTracker);
  const capacityStartupStabilization = timing.inStartupStabilization && context.softLimitSource === 'capacity';
  const effectiveTiming = capacityStartupStabilization
    ? timing
    : {
        ...timing,
        inStartupStabilization: false as const,
        startupStabilizationRemainingSec: null,
        inShedWindow: timing.inCooldown || timing.activeOvershoot || timing.inRestoreCooldown,
      };
  cleanupStaleSwaps(swapState, deps.structuredLog);
  cleanupCompletedSwaps(swapState, deviceMap);

  const restoredThisCycle = new Set<string>();
  let availableHeadroom = guardInShortfall
    ? context.headroomRaw
    : reserveHeadroomForPendingRestores({
      rawHeadroom: context.headroomRaw,
      planDevices,
      lastDeviceRestoreMs: state.lastDeviceRestoreMs,
      measurementTs: deps.powerTracker.lastTimestamp ?? null,
      debugStructured: deps.debugStructured,
      deviceNameById: deps.deviceNameById,
    });
  let restoredOneThisCycle = false;
  const batchState = buildRestoreBatchState({
    context,
    timing: effectiveTiming,
    availableHeadroom,
  });

  if (guardInShortfall) {
    markRestoreCandidatesStayShedForShortfall({
      deviceMap,
      headroomKw: context.headroomRaw,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
    });
  } else if (shouldPlanRestores(context.headroomRaw, sheddingActive, effectiveTiming)) {
    const snapshot = Array.from(deviceMap.values());
    const restoreCandidates = getRestoreCandidates(snapshot);
    const onDevices = getOnDevices(snapshot, deps.getShedBehavior);
    const steppedSwapExecutor = buildSteppedSwapExecutor({
      deviceMap,
      onDevices,
      swapState,
      state,
      timing: effectiveTiming,
      restoredThisCycle,
      deps,
    });
    ({ availableHeadroom, restoredOneThisCycle } = applyRestoreCandidates({
      restoreCandidates,
      deviceMap,
      onDevices,
      swapState,
      state,
      timing: effectiveTiming,
      availableHeadroom,
      restoredThisCycle,
      restoredOneThisCycle,
      batchState,
      deps,
      steppedSwapExecutor,
    }));
    ({ availableHeadroom, restoredOneThisCycle } = applyActiveSteppedRestoreCandidates({
      deviceMap,
      swapState,
      state,
      timing: effectiveTiming,
      availableHeadroom,
      restoredOneThisCycle,
      debugStructured: deps.debugStructured,
      steppedSwapExecutor,
    }));
  } else if (
    sheddingActive
    || timing.inCooldown
    || effectiveTiming.inStartupStabilization
  ) {
    markOffDevicesStayOff({
      deviceMap,
      timing: effectiveTiming,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
      getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    });
    markSteppedDevicesStayAtCurrentLevel({
      deviceMap,
      timing: effectiveTiming,
      getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    });
  } else if (effectiveTiming.inRestoreCooldown) {
    ({ availableHeadroom, restoredOneThisCycle } = applyRestorePlanInCooldown({
      deviceMap, swapState, state, effectiveTiming, deps,
      availableHeadroom, restoredOneThisCycle, restoredThisCycle,
    }));
  }

  return {
    planDevices: Array.from(deviceMap.values()),
    stateUpdates: exportSwapState(swapState),
    restoredThisCycle,
    availableHeadroom,
    restoredOneThisCycle,
    ...effectiveTiming,
  };
}

function applyRestoreCandidates(params: {
  restoreCandidates: RestoreCandidate[];
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  state: PlanEngineState;
  timing: Parameters<typeof planRestoreForDevice>[0]['timing'];
  availableHeadroom: number;
  restoredThisCycle: Set<string>;
  restoredOneThisCycle: boolean;
  batchState: RestoreBatchState;
  deps: RestoreDeps;
  steppedSwapExecutor: SteppedSwapExecutor;
}): RestoreLoopState {
  let { availableHeadroom, restoredOneThisCycle } = params;
  for (const candidate of params.restoreCandidates) {
    const result = applyRestoreCandidate({
      candidate,
      deviceMap: params.deviceMap,
      onDevices: params.onDevices,
      swapState: params.swapState,
      state: params.state,
      timing: params.timing,
      availableHeadroom,
      restoredThisCycle: params.restoredThisCycle,
      restoredOneThisCycle,
      batchState: params.batchState,
      deps: params.deps,
      steppedSwapExecutor: params.steppedSwapExecutor,
    });
    availableHeadroom = result.availableHeadroom;
    restoredOneThisCycle = result.restoredOneThisCycle;
  }
  return { availableHeadroom, restoredOneThisCycle };
}

// Single shared entry for every stepped-restore path. It applies the pending-swap source-off
// hold (a stepped-swap target must not be restored while its swapped-out sources are still on)
// and then routes through planRestoreForSteppedDevice with the stepped-swap executor context.
// Funnelling normal restore, restore cooldown, meter-settling, and active stepped-upgrade paths
// through here keeps both admission wrappers applied uniformly.
function planSteppedRestoreThroughSourceHold(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  swapState: SwapState;
  state: PlanEngineState;
  timing: Parameters<typeof planRestoreForSteppedDevice>[0]['timing'];
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  debugStructured: RestoreDeps['debugStructured'];
  steppedSwapExecutor: SteppedSwapExecutor;
}): RestoreLoopState {
  const { dev, deviceMap, swapState, availableHeadroom, restoredOneThisCycle } = params;
  if (holdPendingSwapTargetUntilSourcesAreOff({ swapState, targetDevice: dev, deviceMap })) {
    return { availableHeadroom, restoredOneThisCycle };
  }
  return planRestoreForSteppedDevice({
    dev,
    deviceMap,
    state: params.state,
    timing: params.timing,
    availableHeadroom,
    restoredOneThisCycle,
    debugStructured: params.debugStructured,
    swapExecutor: params.steppedSwapExecutor,
  });
}

function applyActiveSteppedRestoreCandidates(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  swapState: SwapState;
  state: PlanEngineState;
  timing: Parameters<typeof planRestoreForSteppedDevice>[0]['timing'];
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  debugStructured: RestoreDeps['debugStructured'];
  steppedSwapExecutor: SteppedSwapExecutor;
}): RestoreLoopState {
  let { availableHeadroom, restoredOneThisCycle } = params;
  const activeSteppedDevices = getSteppedRestoreCandidates(Array.from(params.deviceMap.values()))
    .filter((dev) => isActiveSteppedRestoreCandidate(dev));
  for (const dev of activeSteppedDevices) {
    ({ availableHeadroom, restoredOneThisCycle } = planSteppedRestoreThroughSourceHold({
      dev,
      deviceMap: params.deviceMap,
      swapState: params.swapState,
      state: params.state,
      timing: params.timing,
      availableHeadroom,
      restoredOneThisCycle,
      debugStructured: params.debugStructured,
      steppedSwapExecutor: params.steppedSwapExecutor,
    }));
  }
  return { availableHeadroom, restoredOneThisCycle };
}

function applyRestoreCandidate(params: {
  candidate: RestoreCandidate;
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  state: PlanEngineState;
  timing: Parameters<typeof planRestoreForDevice>[0]['timing'];
  availableHeadroom: number;
  restoredThisCycle: Set<string>;
  restoredOneThisCycle: boolean;
  batchState: RestoreBatchState;
  deps: RestoreDeps;
  steppedSwapExecutor: SteppedSwapExecutor;
}): RestoreLoopState {
  const dev = params.deviceMap.get(params.candidate.device.id);
  const currentState = {
    availableHeadroom: params.availableHeadroom,
    restoredOneThisCycle: params.restoredOneThisCycle,
  };
  if (!dev) return currentState;
  if (holdPendingSwapTargetUntilSourcesAreOff({
    swapState: params.swapState,
    targetDevice: dev,
    deviceMap: params.deviceMap,
  })) return currentState;
  if (params.candidate.kind === 'binary' && isBinaryRestoreCandidate(dev)) {
    return planRestoreForDevice({
      dev,
      deviceMap: params.deviceMap,
      onDevices: params.onDevices,
      swapState: params.swapState,
      state: params.state,
      timing: params.timing,
      availableHeadroom: params.availableHeadroom,
      restoredThisCycle: params.restoredThisCycle,
      restoredOneThisCycle: params.restoredOneThisCycle,
      batchState: params.batchState,
      deps: params.deps,
    });
  }
  if (params.candidate.kind === 'stepped' && isOffSteppedRestoreCandidate(dev)) {
    return planSteppedRestoreThroughSourceHold({
      dev,
      deviceMap: params.deviceMap,
      swapState: params.swapState,
      state: params.state,
      timing: params.timing,
      availableHeadroom: params.availableHeadroom,
      restoredOneThisCycle: params.restoredOneThisCycle,
      debugStructured: params.deps.debugStructured,
      steppedSwapExecutor: params.steppedSwapExecutor,
    });
  }
  return currentState;
}

function buildSteppedSwapExecutor(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  state: PlanEngineState;
  timing: Pick<RestoreTiming, 'measurementTs'>;
  restoredThisCycle: Set<string>;
  deps: RestoreDeps;
}): SteppedSwapExecutor {
  const { deviceMap, onDevices, swapState, state, timing, restoredThisCycle, deps } = params;
  return ({ dev, needed, devPower, availableHeadroom, admittedDeviceUpdate, rejectedDeviceUpdate }) => (
    attemptSwapRestore({
      dev,
      deviceMap,
      onDevices,
      swapState,
      phase: resolveRestoreDecisionPhase(state.currentRebuildReason),
      availableHeadroom,
      restoreNeed: { needed, devPower, penaltyLevel: 0, penaltyExtraKw: 0 },
      measurementTs: timing.measurementTs,
      restoredThisCycle,
      deps,
      admittedDeviceUpdate,
      rejectedDeviceUpdate,
    })
  );
}

// Handles the inRestoreCooldown branch of applyRestorePlan, extracted to keep that function's
// cognitive complexity within the allowed ceiling.
function applyRestorePlanInCooldown(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  swapState: SwapState;
  state: PlanEngineState;
  effectiveTiming: RestoreTiming;
  deps: RestoreDeps;
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { deviceMap, swapState, state, effectiveTiming, deps, restoredThisCycle } = params;
  let { availableHeadroom, restoredOneThisCycle } = params;
  const steppedSwapExecutor = buildSteppedSwapExecutor({
    deviceMap,
    onDevices: getOnDevices(Array.from(deviceMap.values()), deps.getShedBehavior),
    swapState,
    state,
    timing: effectiveTiming,
    restoredThisCycle,
    deps,
  });
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing: effectiveTiming,
    lastRestoreTs: state.lastRestoreMs,
  });
  if (meterSettlingRemainingSec !== null) {
    markOffDevicesMeterSettling({ deviceMap, timing: effectiveTiming, lastRestoreTs: state.lastRestoreMs });
  } else {
    markOffDevicesStayOff({
      deviceMap,
      timing: effectiveTiming,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
      getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    });
  }
  // Run stepped candidates through planRestoreForSteppedDevice even during global restore
  // cooldown. Off stepped devices get the cooldown gate applied inside the function; active
  // stepped devices bypass it (they were already drawing power before the last restore).
  // In the meter-settling sub-path, off stepped devices are already marked above, so only
  // active devices need processing.
  //
  // Funnel through planSteppedRestoreThroughSourceHold so the pending-swap source-off hold and
  // stepped-swap executor context apply here exactly as they do on the normal restore path —
  // an active stepped-swap target must not escalate while its swapped-out sources are still on.
  const steppedCandidates = getSteppedRestoreCandidates(Array.from(deviceMap.values()));
  const eligibleStepped = meterSettlingRemainingSec !== null
    ? steppedCandidates.filter((dev) => isActiveSteppedRestoreCandidate(dev))
    : steppedCandidates;
  for (const dev of eligibleStepped) {
    ({ availableHeadroom, restoredOneThisCycle } = planSteppedRestoreThroughSourceHold({
      dev,
      deviceMap,
      swapState,
      state,
      timing: effectiveTiming,
      availableHeadroom,
      restoredOneThisCycle,
      debugStructured: deps.debugStructured,
      steppedSwapExecutor,
    }));
  }
  return { availableHeadroom, restoredOneThisCycle };
}
