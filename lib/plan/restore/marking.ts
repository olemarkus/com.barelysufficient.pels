import type { DevicePlanDevice } from '../planTypes';
import { computeBaseRestoreNeed } from './accounting';
import {
  getInactiveReason,
  getOffDevices,
  getSteppedRestoreCandidates,
  isOffSteppedRestoreCandidate,
  markOffDevicesStayOff,
} from './devices';
import { buildOffSteppedRestoreShedUpdate, setRestorePlanDevice as setDevice } from './helpers';
import { materializeShedSnapshotFields } from '../planActionMaterialization';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import {
  resolveMeterSettlingCountdownTiming,
  resolveMeterSettlingRemainingSec,
  type RestoreTiming,
} from './timing';
import { buildMeterSettlingReason, buildShortfallReason } from '../planReasonStrings';

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
      startupStabilizationRemainingSec: null,
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

export function markOffDevicesMeterSettling(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  timing: Pick<
    RestoreTiming,
    'activeOvershoot' | 'measurementTs' | 'nowTs'
  >;
  lastRestoreTs?: number | null;
}): void {
  const { deviceMap, timing, lastRestoreTs = null } = params;
  const remainingSec = resolveMeterSettlingRemainingSec({ timing, lastRestoreTs });
  if (remainingSec === null) return;
  const reason = buildMeterSettlingReason(
    remainingSec,
    resolveMeterSettlingCountdownTiming({ timing, lastRestoreTs }),
  );
  const snapshot: DevicePlanDevice[] = [];
  for (const dev of deviceMap.values()) snapshot.push(dev);

  const meterSettlingDevices = [
    ...getOffDevices(snapshot),
    ...getSteppedRestoreCandidates(snapshot).filter((dev) => isOffSteppedRestoreCandidate(dev)),
  ];

  for (const dev of meterSettlingDevices) {
    const inactiveReason = getInactiveReason(dev);
    if (inactiveReason) {
      setDevice(deviceMap, dev.id, {
        plannedState: 'inactive',
        reason: inactiveReason,
      });
      continue;
    }

    const updates: Partial<DevicePlanDevice> = { plannedState: 'shed', reason };
    if (isSteppedLoadDevice(dev)) {
      Object.assign(updates, buildOffSteppedRestoreShedUpdate(dev));
    }
    setDevice(deviceMap, dev.id, updates);
  }
}
