import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import type { SwapState } from '../swap';
import {
  getSteppedRestoreCandidates,
  isActiveSteppedRestoreCandidate,
  isBinaryRestoreCandidate,
  isOffSteppedRestoreCandidate,
  type RestoreCandidate,
} from './devices';
import {
  planRestoreForSteppedDevice,
  type SteppedSwapExecutor,
} from './helpers';
import type { RestoreTiming } from './timing';
import { resolveRestoreDecisionPhase, type HeadroomReserve } from '../admission';
import type { RestoreHeadroomLedger } from './headroomLedger';
import { attemptSwapRestore, holdPendingSwapTargetUntilSourcesAreOff } from './swap';
import { planRestoreForDevice } from './gating';
import type { RestoreBatchState, RestoreDeps, RestoreLoopState } from './types';

export function applyRestoreCandidates(params: {
  restoreCandidates: RestoreCandidate[];
  deviceMap: Map<string, DevicePlanDevice>;
  onDevices: DevicePlanDevice[];
  swapState: SwapState;
  state: PlanEngineState;
  timing: Parameters<typeof planRestoreForDevice>[0]['timing'];
  ledger: RestoreHeadroomLedger;
  restoredThisCycle: Set<string>;
  restoredOneThisCycle: boolean;
  batchState: RestoreBatchState;
  deps: RestoreDeps;
  steppedSwapExecutor: SteppedSwapExecutor;
  headroomReserves: readonly HeadroomReserve[];
}): { restoredOneThisCycle: boolean } {
  let { restoredOneThisCycle } = params;
  for (const candidate of params.restoreCandidates) {
    // Ledger translation: the inner gates keep their single availableKw scalar;
    // the axis choice (exempt → capacity, else min with the measured-exempt
    // budget axis) and the per-axis debit live here.
    const availableForCandidate = params.ledger.availableFor(candidate.device);
    const result = applyRestoreCandidate({
      candidate,
      deviceMap: params.deviceMap,
      onDevices: params.onDevices,
      swapState: params.swapState,
      state: params.state,
      timing: params.timing,
      availableHeadroom: availableForCandidate,
      restoredThisCycle: params.restoredThisCycle,
      restoredOneThisCycle,
      batchState: params.batchState,
      deps: params.deps,
      steppedSwapExecutor: params.steppedSwapExecutor,
      headroomReserves: params.headroomReserves,
    });
    params.ledger.commit(candidate.device, availableForCandidate - result.availableHeadroom);
    restoredOneThisCycle = result.restoredOneThisCycle;
  }
  return { restoredOneThisCycle };
}

// Single shared entry for every stepped-restore path. It applies the pending-swap source-off
// hold (a stepped-swap target must not be restored while its swapped-out sources are still on)
// and then routes through planRestoreForSteppedDevice with the stepped-swap executor context.
// Funnelling normal restore, restore cooldown, meter-settling, and active stepped-upgrade paths
// through here keeps both admission wrappers applied uniformly.
export function planSteppedRestoreThroughSourceHold(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  swapState: SwapState;
  state: PlanEngineState;
  timing: Parameters<typeof planRestoreForSteppedDevice>[0]['timing'];
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  debugStructured: RestoreDeps['debugStructured'];
  steppedSwapExecutor: SteppedSwapExecutor;
  headroomReserves: readonly HeadroomReserve[];
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
    headroomReserves: params.headroomReserves,
  });
}

export function applyActiveSteppedRestoreCandidates(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  swapState: SwapState;
  state: PlanEngineState;
  timing: Parameters<typeof planRestoreForSteppedDevice>[0]['timing'];
  ledger: RestoreHeadroomLedger;
  restoredOneThisCycle: boolean;
  debugStructured: RestoreDeps['debugStructured'];
  steppedSwapExecutor: SteppedSwapExecutor;
  headroomReserves: readonly HeadroomReserve[];
  candidateFilter?: (dev: DevicePlanDevice) => boolean;
}): { restoredOneThisCycle: boolean } {
  let { restoredOneThisCycle } = params;
  const activeSteppedDevices = getSteppedRestoreCandidates(Array.from(params.deviceMap.values()))
    .filter((dev) => isActiveSteppedRestoreCandidate(dev))
    .filter((dev) => params.candidateFilter?.(dev) ?? true);
  for (const dev of activeSteppedDevices) {
    const availableForCandidate = params.ledger.availableFor(dev);
    const result = planSteppedRestoreThroughSourceHold({
      dev,
      deviceMap: params.deviceMap,
      swapState: params.swapState,
      state: params.state,
      timing: params.timing,
      availableHeadroom: availableForCandidate,
      restoredOneThisCycle,
      debugStructured: params.debugStructured,
      steppedSwapExecutor: params.steppedSwapExecutor,
      headroomReserves: params.headroomReserves,
    });
    params.ledger.commit(dev, availableForCandidate - result.availableHeadroom);
    restoredOneThisCycle = result.restoredOneThisCycle;
  }
  return { restoredOneThisCycle };
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
  headroomReserves: readonly HeadroomReserve[];
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
      headroomReserves: params.headroomReserves,
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
      headroomReserves: params.headroomReserves,
    });
  }
  return currentState;
}

export function buildSteppedSwapExecutor(params: {
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
