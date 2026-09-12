import type { DevicePlanDevice } from '../planTypes';
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { SwapLedger } from '../swap';
import { computeBaseRestoreNeed } from './accounting';
import {
  getInactiveReason,
  getOffDevices,
  getSteppedRestoreCandidates,
  isOffSteppedRestoreCandidate,
  markOffDevicesStayOff,
} from './devices';
import { buildOffSteppedRestoreShedUpdate, setRestorePlanDevice as setDevice } from './helpers';
import { buildOffSteppedRestoreHoldUpdate } from './planDeviceUpdates';
import { materializeShedSnapshotFields } from '../planActionMaterialization';
import { holdPendingSwapTargetUntilSourcesAreOff } from './swap';
import { buildShortfallReason } from '../planReasonStrings';

function buildRestoreShortfallReason(dev: DevicePlanDevice, headroomKw: number): DevicePlanDevice['reason'] {
  const { needed } = computeBaseRestoreNeed(dev);
  return buildShortfallReason(needed, headroomKw);
}

export function markRestoreCandidatesStayShedForShortfall(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  headroomKw: number;
  setDevice: (id: string, updates: Partial<DevicePlanDevice>) => void;
}): void {
  const { deviceMap, headroomKw, setDevice: setPlanDevice } = params;
  const steppedCandidates = getSteppedRestoreCandidates([...deviceMap.values()]);
  markOffDevicesStayOff({
    deviceMap,
    timing: {
      activeOvershoot: false,
      inCooldown: false,
      inStartupStabilization: false,
      restoreCooldownSeconds: 0,
      shedCooldownRemainingSec: null,
    },
    setDevice: setPlanDevice,
    reasonOverride: (dev) => buildRestoreShortfallReason(dev, headroomKw),
  });

  for (const dev of steppedCandidates) {
    const currentOff = isOffSteppedRestoreCandidate(dev);
    const reason = buildRestoreShortfallReason(dev, headroomKw);
    let update: Partial<DevicePlanDevice> = {
      reason,
    };
    if (currentOff) {
      const offUpdate = buildOffSteppedRestoreShedUpdate(dev);
      update = {
        plannedState: offUpdate.plannedState,
        desiredStepId: offUpdate.desiredStepId,
        targetStepId: offUpdate.targetStepId,
        shedAction: offUpdate.shedAction,
        reason,
      };
    }
    if (!currentOff && dev.selectedStepId !== undefined) {
      // Route the post-plan revision through the chunk-6 materialisation adapter so this
      // site shares the single shed-action snapshot contract. The intent is `set_step`
      // with `targetStepId` set to the specific step the revision targets — the adapter
      // forwards it to `releaseShedStepId` on the projected triple.
      const triple = materializeShedSnapshotFields({
        intent: { kind: 'set_step', targetStepId: dev.selectedStepId },
        shouldShed: true,
      });
      update.plannedState = 'shed';
      update.desiredStepId = dev.selectedStepId;
      update.targetStepId = dev.selectedStepId;
      update.shedAction = triple.shedAction;
      update.shedTemperature = triple.shedTemperature;
      update.releaseShedStepId = triple.releaseShedStepId;
    }
    setPlanDevice(dev.id, update);
  }
}

/**
 * Hold every restore candidate this cycle with ONE reason — the cooldown lane's
 * timer (`applyRestorePlanInCooldown`). Off binary candidates stay off, off
 * stepped candidates keep their off-step shed update, and active stepped
 * candidates (on, below target) keep their level. A swap target whose
 * swapped-out sources are still on keeps its swap hold instead: the swap in
 * flight is the more specific fact, and the reason the executor acts on.
 *
 * Like the stay-off marking beside it (`markOffDevicesStayOff`), this does not
 * walk the admission ladder, so a device inside an activation setback reads the
 * timer rather than the setback for the length of the cooldown; the setback
 * reason returns on the first pass that actually decides.
 */
export function markRestoreCandidatesHeld(
  deviceMap: Map<string, DevicePlanDevice>,
  swapLedger: SwapLedger,
  reason: DeviceReason,
): void {
  const snapshot = [...deviceMap.values()];
  for (const dev of getOffDevices(snapshot)) {
    if (holdPendingSwapTargetUntilSourcesAreOff(swapLedger, dev, deviceMap)) continue;
    const inactiveReason = getInactiveReason(dev);
    setDevice(deviceMap, dev.id, inactiveReason
      ? { plannedState: 'inactive', reason: inactiveReason }
      : { plannedState: 'shed', reason });
  }
  for (const dev of getSteppedRestoreCandidates(snapshot)) {
    if (holdPendingSwapTargetUntilSourcesAreOff(swapLedger, dev, deviceMap)) continue;
    const inactiveReason = getInactiveReason(dev);
    if (inactiveReason) {
      setDevice(deviceMap, dev.id, { plannedState: 'inactive', reason: inactiveReason });
      continue;
    }
    setDevice(deviceMap, dev.id, isOffSteppedRestoreCandidate(dev)
      ? buildOffSteppedRestoreHoldUpdate(dev, reason)
      : { reason });
  }
}
