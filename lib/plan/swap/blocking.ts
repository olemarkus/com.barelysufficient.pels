import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../planTypes';
import { setRestorePlanDevice } from '../planRestoreHelpers';
import { isSwapTargetComplete } from './completion';
import { clearDirectSwap, clearMissingSwapTarget, clearSwapTargetPreservingMeasurement } from './lifecycle';
import type { SwapState } from './state';

export function isBlockedBySwapState(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
): boolean {
  if (isBlockedByDirectSwap(dev, deviceMap, swapState)) return true;
  return isBlockedByPendingSwapTarget(dev, deviceMap, swapState);
}

function isBlockedByDirectSwap(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
): boolean {
  const swappedFor = swapState.swappedOutFor.get(dev.id);
  if (!swappedFor) return false;
  const higherPriDev = deviceMap.get(swappedFor);
  if (!higherPriDev) {
    clearDirectSwap(swapState, dev.id);
    clearMissingSwapTarget(swapState, swappedFor);
    return false;
  }
  if (!isSwapTargetComplete(higherPriDev, swapState)) {
    setRestorePlanDevice(deviceMap, dev.id, {
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swapPending, targetName: higherPriDev.name },
    });
    return true;
  }
  clearDirectSwap(swapState, dev.id);
  clearSwapTargetPreservingMeasurement(swapState, swappedFor);
  return false;
}

function isBlockedByPendingSwapTarget(
  dev: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  swapState: SwapState,
): boolean {
  if (swapState.pendingSwapTargets.size === 0 || swapState.pendingSwapTargets.has(dev.id)) return false;
  const devPriority = dev.priority ?? 100;
  for (const swapTargetId of swapState.pendingSwapTargets) {
    if (swapTargetId === dev.id) continue;
    const swapTargetDev = deviceMap.get(swapTargetId);
    if (!swapTargetDev) {
      clearMissingSwapTarget(swapState, swapTargetId);
      continue;
    }
    const swapTargetPriority = swapTargetDev.priority ?? 100;
    if (swapTargetPriority <= devPriority && !isSwapTargetComplete(swapTargetDev, swapState)) {
      setRestorePlanDevice(deviceMap, dev.id, {
        plannedState: 'shed',
        reason: { code: PLAN_REASON_CODES.swapPending, targetName: swapTargetDev.name },
      });
      return true;
    }
    if (isSwapTargetComplete(swapTargetDev, swapState)) {
      clearSwapTargetPreservingMeasurement(swapState, swapTargetId);
    }
  }
  return false;
}
