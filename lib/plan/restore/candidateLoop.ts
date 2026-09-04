import type { DevicePlanDevice, SteppedPlanDevice } from '../planTypes';
import { isSteppedLoadDevice } from '../planSteppedLoad';
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
import type { RestoreHeadroomLedger } from './headroomLedger';
import { attemptSwapRestore, holdPendingSwapTargetUntilSourcesAreOff } from './swap';
import { planRestoreForDevice } from './gating';
import type { RestoreCycle, RestoreLane, RestoreLoopState } from './types';

export function applyRestoreCandidates(
  cycle: RestoreCycle,
  lane: RestoreLane,
  restoreCandidates: RestoreCandidate[],
  ledger: RestoreHeadroomLedger,
  restoredOneThisCycle: boolean,
): { restoredOneThisCycle: boolean } {
  let restoredOne = restoredOneThisCycle;
  for (const candidate of restoreCandidates) {
    // Ledger translation: the inner gates keep their single availableKw scalar;
    // the axis choice (exempt → capacity, else min with the measured-exempt
    // budget axis) and the per-axis debit live here.
    const availableForCandidate = ledger.availableFor(candidate.device);
    const result = applyRestoreCandidate(cycle, lane, candidate, {
      availableHeadroom: availableForCandidate,
      restoredOneThisCycle: restoredOne,
    });
    ledger.commit(candidate.device, availableForCandidate - result.availableHeadroom);
    restoredOne = result.restoredOneThisCycle;
  }
  return { restoredOneThisCycle: restoredOne };
}

// Single shared entry for every stepped-restore path. It applies the pending-swap source-off
// hold (a stepped-swap target must not be restored while its swapped-out sources are still on)
// and then routes through planRestoreForSteppedDevice with the stepped-swap executor context.
// Funnelling normal restore, restore cooldown, meter-settling, and active stepped-upgrade paths
// through here keeps both admission wrappers applied uniformly.
export function planSteppedRestoreThroughSourceHold(
  cycle: RestoreCycle,
  lane: RestoreLane,
  dev: SteppedPlanDevice,
  loop: RestoreLoopState,
): RestoreLoopState {
  if (holdPendingSwapTargetUntilSourcesAreOff(cycle.swapState, dev, cycle.deviceMap)) return loop;
  return planRestoreForSteppedDevice({
    dev,
    deviceMap: cycle.deviceMap,
    state: cycle.state,
    timing: cycle.timing,
    availableHeadroom: loop.availableHeadroom,
    restoredOneThisCycle: loop.restoredOneThisCycle,
    debugStructured: cycle.deps.debugStructured,
    swapExecutor: lane.steppedSwapExecutor,
    headroomReserves: cycle.headroomReserves,
    admissionMode: cycle.admissionMode,
  });
}

export function applyActiveSteppedRestoreCandidates(
  cycle: RestoreCycle,
  lane: RestoreLane,
  ledger: RestoreHeadroomLedger,
  restoredOneThisCycle: boolean,
  candidateFilter?: (dev: DevicePlanDevice) => boolean,
): { restoredOneThisCycle: boolean } {
  let restoredOne = restoredOneThisCycle;
  const activeSteppedDevices = getSteppedRestoreCandidates(Array.from(cycle.deviceMap.values()))
    .filter((dev) => isActiveSteppedRestoreCandidate(dev))
    .filter((dev) => candidateFilter?.(dev) ?? true);
  for (const dev of activeSteppedDevices) {
    const availableForCandidate = ledger.availableFor(dev);
    const result = planSteppedRestoreThroughSourceHold(cycle, lane, dev, {
      availableHeadroom: availableForCandidate,
      restoredOneThisCycle: restoredOne,
    });
    ledger.commit(dev, availableForCandidate - result.availableHeadroom);
    restoredOne = result.restoredOneThisCycle;
  }
  return { restoredOneThisCycle: restoredOne };
}

function applyRestoreCandidate(
  cycle: RestoreCycle,
  lane: RestoreLane,
  candidate: RestoreCandidate,
  loop: RestoreLoopState,
): RestoreLoopState {
  const dev = cycle.deviceMap.get(candidate.device.id);
  if (!dev) return loop;
  if (holdPendingSwapTargetUntilSourcesAreOff(cycle.swapState, dev, cycle.deviceMap)) return loop;
  if (candidate.kind === 'binary' && isBinaryRestoreCandidate(dev)) {
    return planRestoreForDevice(cycle, lane, dev, loop);
  }
  if (candidate.kind === 'stepped' && isSteppedLoadDevice(dev) && isOffSteppedRestoreCandidate(dev)) {
    return planSteppedRestoreThroughSourceHold(cycle, lane, dev, loop);
  }
  return loop;
}

export function buildSteppedSwapExecutor(
  cycle: RestoreCycle,
  onDevices: DevicePlanDevice[],
): SteppedSwapExecutor {
  return ({
    dev, needed, devPower, availableHeadroom, restoreDebugKey,
    admittedDeviceUpdate, rejectedDeviceUpdate,
  }) => (
    attemptSwapRestore(
      cycle,
      onDevices,
      dev,
      availableHeadroom,
      { needed, devPower, penaltyLevel: 0, penaltyExtraKw: 0 },
      restoreDebugKey,
      { admitted: admittedDeviceUpdate ?? {}, rejected: rejectedDeviceUpdate ?? {} },
    )
  );
}
