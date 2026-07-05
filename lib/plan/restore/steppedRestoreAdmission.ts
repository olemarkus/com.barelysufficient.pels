import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import type { StructuredDebugEmitter } from '../../logging/logger';
import {
  buildComparableDeviceReason,
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../../packages/shared-domain/src/planReasonSemantics';
import { isOffSteppedRestoreCandidate } from './devices';
import { computeRestoreBufferKw } from './accounting';
import { RESTORE_ADMISSION_FLOOR_KW } from '../planConstants';
import { emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { isBoostActive } from '../../device/deviceActionProjection';
import { countShedDevices } from './coordination';
import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  type RestoreAdmissionMetrics,
} from '../admission';
import { buildRestoreHeadroomReason } from '../planReasonStrings';
import {
  buildOffSteppedRestoreShedUpdate,
  resolveRejectedSteppedSwapUpdate,
  setRestorePlanDevice,
} from './planDeviceUpdates';

export type SteppedSwapExecutor = (params: {
  dev: DevicePlanDevice;
  needed: number;
  devPower: number;
  availableHeadroom: number;
  admittedDeviceUpdate: Partial<DevicePlanDevice>;
  rejectedDeviceUpdate: Partial<DevicePlanDevice>;
}) => { availableHeadroom: number; restoredOneThisCycle: boolean };

export function admitSteppedRestore(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  phase: 'startup' | 'runtime';
  nextStep: { id: string; planningPowerW: number };
  lowestNonZeroStep: { id: string; planningPowerW: number } | null;
  deltaKw: number;
  availableHeadroom: number;
  debugStructured?: StructuredDebugEmitter;
  restoreDebugKey: string;
  swapExecutor?: SteppedSwapExecutor;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, state, phase, nextStep, lowestNonZeroStep,
    deltaKw, availableHeadroom, debugStructured, restoreDebugKey, swapExecutor } = params;
  const restoreBuffer = computeRestoreBufferKw(deltaKw);
  const needed = deltaKw + restoreBuffer;
  const admission = buildRestoreAdmissionMetrics({ availableKw: availableHeadroom, neededKw: needed });
  const shedDeviceCount = countShedDevices(deviceMap, dev.id);
  if (admission.postReserveMarginKw < RESTORE_ADMISSION_FLOOR_KW) {
    if (swapExecutor
        && canUseSwapForSteppedRestore({ dev, nextStep, lowestNonZeroStep })) {
      return swapExecutor({
        dev,
        needed,
        devPower: nextStep.planningPowerW / 1000,
        availableHeadroom,
        admittedDeviceUpdate: {
          desiredStepId: nextStep.id,
          targetStepId: nextStep.id,
          expectedPowerKw: nextStep.planningPowerW / 1000,
          reason: {
            code: PLAN_REASON_CODES.restoreNeed,
            fromTarget: dev.selectedStepId ?? 'unknown',
            toTarget: nextStep.id,
            needKw: needed,
            headroomKw: null,
          },
        },
        rejectedDeviceUpdate: resolveRejectedSteppedSwapUpdate(dev),
      });
    }
    return rejectSteppedRestoreForInsufficientHeadroom({
      dev, deviceMap, state, phase, nextStep, lowestNonZeroStep, shedDeviceCount,
      admission, availableHeadroom, needed, debugStructured, restoreDebugKey,
    });
  }
  setRestorePlanDevice(deviceMap, dev.id, {
    desiredStepId: nextStep.id,
    expectedPowerKw: nextStep.planningPowerW / 1000,
    reason: {
      code: PLAN_REASON_CODES.restoreNeed,
      fromTarget: dev.selectedStepId ?? 'unknown',
      toTarget: nextStep.id,
      needKw: needed,
      headroomKw: null,
    },
  });
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_stepped_admitted',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId ?? 'unknown',
      toStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep?.id,
      blockedByShedInvariant: false,
      shedDeviceCount,
      deltaKw,
      neededKw: needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'admitted',
    },
    debugStructured,
  });
  return { availableHeadroom: availableHeadroom - needed, restoredOneThisCycle: true };
}

export function blockSteppedRestoreForShedInvariant(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  nextStep: { id: string; planningPowerW: number };
  lowestNonZeroStep: { id: string; planningPowerW: number } | null;
  phase: 'startup' | 'runtime';
  debugStructured?: StructuredDebugEmitter;
  restoreDebugKey: string;
}): boolean {
  const { dev, deviceMap, state, nextStep, lowestNonZeroStep, phase, debugStructured, restoreDebugKey } = params;
  // Boost is the user's priority override: it bypasses the fairness invariant
  // unconditionally, with no draw-evidence consult (gating on evidence
  // re-blocked a boosted climb for minutes per rung — see the staircase
  // regression in planRestoreBoostShedInvariantBypass.test.ts). An
  // idle-at-setpoint device that escalates anyway is bounded by per-rung
  // headroom admission, the stepped attempt-hold (each rung must settle
  // before the next), and per-device restore timing. The evidence gate
  // remains only on the swap path (`canUseSwapForSteppedRestore`), where
  // phantom boost demand would pause a running lower-priority device.
  if (isBoostActive(dev)) return false;
  if (!lowestNonZeroStep || nextStep.planningPowerW <= lowestNonZeroStep.planningPowerW) return false;
  const shedDeviceCount = countShedDevices(deviceMap, dev.id);
  if (shedDeviceCount === 0) return false;
  const reason = {
    code: PLAN_REASON_CODES.shedInvariant,
    fromStep: dev.selectedStepId ?? 'unknown',
    toStep: nextStep.id,
    shedDeviceCount,
    maxStep: lowestNonZeroStep.id,
  } as const;
  setRestorePlanDevice(deviceMap, dev.id, { reason });

  const prev = state.steppedRestoreRejectedByDevice[dev.id];
  const unchanged = prev !== undefined
    && prev.requestedStepId === nextStep.id
    && prev.lowestNonZeroStepId === lowestNonZeroStep.id
    && prev.shedDeviceCount === shedDeviceCount;
  if (!unchanged) {
    emitRestoreDebugEventOnChange({
      state,
      key: restoreDebugKey,
      payload: {
        event: 'restore_stepped_rejected',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        currentStepId: dev.selectedStepId ?? 'unknown',
        requestedStepId: nextStep.id,
        lowestNonZeroStepId: lowestNonZeroStep.id,
        allowedMaxStepId: lowestNonZeroStep.id,
        blockedByShedInvariant: true,
        shedDeviceCount,
        decision: 'rejected',
        rejectionReason: 'shed_invariant',
        reason: formatDeviceReason(reason),
      },
      signaturePayload: {
        event: 'restore_stepped_rejected',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        currentStepId: dev.selectedStepId ?? 'unknown',
        requestedStepId: nextStep.id,
        lowestNonZeroStepId: lowestNonZeroStep.id,
        allowedMaxStepId: lowestNonZeroStep.id,
        blockedByShedInvariant: true,
        shedDeviceCount,
        decision: 'rejected',
        rejectionReason: 'shed_invariant',
        reason: buildComparableDeviceReason(reason),
      },
      debugStructured,
    });
    state.steppedRestoreRejectedByDevice[dev.id] = {
      requestedStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      shedDeviceCount,
    };
  }
  return true;
}

function canUseSwapForSteppedRestore(params: {
  dev: DevicePlanDevice;
  nextStep: { id: string; planningPowerW: number };
  lowestNonZeroStep: { id: string; planningPowerW: number } | null;
}): boolean {
  const { dev, nextStep, lowestNonZeroStep } = params;
  if (lowestNonZeroStep === null) return false;
  if (isOffSteppedRestoreCandidate(dev) && nextStep.id === lowestNonZeroStep.id) return true;
  return isBoostEffectiveForEscalation(dev);
}

/**
 * True when a boost is active *and* there is no evidence that the device is
 * idle (e.g. a Hoiax holding at its element setpoint, or a thermostat in a
 * room already at target). Calibration-confident `false` for
 * `hasRecentObservedDraw` — no in-band draw at ANY step recently — blocks
 * boost-driven swaps: pausing a running lower-priority device to feed a
 * boosted device that is not accepting load would be pure loss. When the
 * calibration store has no opinion (undefined), the bypass behaves as
 * before so newly-paired devices are not penalized during warm-up.
 * Deliberately NOT consulted by the shed-invariant bypass above — boost
 * overrides fairness unconditionally.
 */
function isBoostEffectiveForEscalation(dev: DevicePlanDevice): boolean {
  if (!isBoostActive(dev)) return false;
  if (dev.hasRecentObservedDraw === false) return false;
  return true;
}

function rejectSteppedRestoreForInsufficientHeadroom(params: {
  dev: DevicePlanDevice;
  deviceMap: Map<string, DevicePlanDevice>;
  state: PlanEngineState;
  phase: 'startup' | 'runtime';
  nextStep: { id: string };
  lowestNonZeroStep: { id: string } | null;
  shedDeviceCount: number;
  admission: RestoreAdmissionMetrics;
  availableHeadroom: number;
  needed: number;
  debugStructured?: StructuredDebugEmitter;
  restoreDebugKey: string;
}): { availableHeadroom: number; restoredOneThisCycle: boolean } {
  const { dev, deviceMap, state, phase, nextStep, lowestNonZeroStep, shedDeviceCount,
    admission, availableHeadroom, needed, debugStructured, restoreDebugKey } = params;
  const reason = buildRestoreHeadroomReason({
    neededKw: needed,
    availableKw: availableHeadroom,
    postReserveMarginKw: admission.postReserveMarginKw,
    minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
  });
  const update: Partial<DevicePlanDevice> = isOffSteppedRestoreCandidate(dev)
    ? { ...buildOffSteppedRestoreShedUpdate(dev), reason }
    : { reason };
  setRestorePlanDevice(deviceMap, dev.id, update);
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId ?? 'unknown',
      requestedStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep?.id,
      blockedByShedInvariant: false,
      shedDeviceCount,
      neededKw: needed,
      availableKw: availableHeadroom,
      ...buildRestoreAdmissionLogFields(admission),
      minimumRequiredPostReserveMarginKw: RESTORE_ADMISSION_FLOOR_KW,
      decision: 'rejected',
      rejectionReason: 'insufficient_headroom',
    },
    debugStructured,
  });
  return { availableHeadroom, restoredOneThisCycle: false };
}
