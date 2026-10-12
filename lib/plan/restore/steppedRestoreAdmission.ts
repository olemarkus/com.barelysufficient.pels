import { spendPowerHeadroom } from '../powerLimitMath';
import type { DevicePlanDevice, SteppedPlanDevice } from '../planTypes';
import {
  PLAN_REASON_CODES,
} from '../../../packages/shared-domain/src/planReasonSemantics';
import { getSteppedLoadLowestActiveStep } from '../../../packages/shared-domain/src/deviceControlProfiles';
import type { SteppedLoadStep } from '../../../packages/contracts/src/types';
import { isOffSteppedRestoreCandidate } from './devices';
import { emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { countShedDevices } from './coordination';
import {
  buildReserveAdmittedLogFields,
  buildReservedForStartReason,
  isReserveAdmitted,
  resolveReserveAdmission,
  type ReserveInsufficient,
} from '../admission';
import { buildRestoreHeadroomReason } from '../planReasonStrings';
import {
  buildSteppedRestoreHoldUpdate,
  resolveRejectedSteppedSwapUpdate,
  setRestorePlanDevice,
} from './planDeviceUpdates';
import { attemptSwapRestore } from './swap';
import type { RestoreCycle, RestoreLane, RestoreLoopState, SteppedRestoreNeed } from './types';
import { recordShedPostureRestoreBatchAdmission } from './batch';

/** The reason a stepped restore climb carries, admitted directly or through a swap. */
function buildSteppedRestoreNeedReason(
  dev: SteppedPlanDevice,
  toStepId: string,
  neededKw: number,
): DevicePlanDevice['reason'] {
  return {
    code: PLAN_REASON_CODES.restoreNeed,
    fromTarget: dev.selectedStepId,
    toTarget: toStepId,
    needKw: neededKw,
  };
}

export function admitSteppedRestore(
  cycle: RestoreCycle,
  lane: RestoreLane,
  dev: SteppedPlanDevice,
  loop: RestoreLoopState,
  nextStep: SteppedLoadStep,
  need: SteppedRestoreNeed,
  batchContinuation: boolean,
): RestoreLoopState {
  const { deviceMap, state, phase, headroomReserves, batchState } = cycle;
  const { deltaKw, neededKw: needed } = need;
  const { availableHeadroom, restoredOneThisCycle } = loop;
  const restoreDebugKey = `stepped:${dev.id}`;
  const lowestNonZeroStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
  // See the binary twin in `gating.ts`: admit against the power this device may actually claim
  // (raw minus any higher-priority startup reservation), while the running headroom total keeps
  // tracking the raw figure.
  const reserved = resolveReserveAdmission({
    dev, availableHeadroom, neededKw: needed, reserves: headroomReserves,
  });
  const shedDeviceCount = countShedDevices(deviceMap, dev.id, state.shedDecisions);
  if (!isReserveAdmitted(reserved)) {
    // Only the reservation is in the way — there is enough raw power, it is just promised to a
    // higher-priority device. Stand down with an honest reason instead of swapping into a block
    // that is already spoken for. Mirror the binary twin's posture (`rejectBinaryRestore`) so an
    // off stepped candidate is recorded as not-resumed rather than left targeting an active step.
    if (reserved.kind === 'blocked_by_reserve') {
      setRestorePlanDevice(deviceMap, dev.id, buildSteppedRestoreHoldUpdate(
        dev, buildReservedForStartReason(reserved.holderName),
      ));
      return loop;
    }
    if (!batchContinuation && canUseSwapForSteppedRestore(dev, nextStep, lowestNonZeroStep)) {
      // Hand the swap the RESERVED figure for the same reason as the binary twin in `gating.ts`:
      // it may only proceed by freeing enough to cover this step on top of a block already
      // promised to a higher-priority device. The raw total is restored on the way out.
      const reservedHeadroomKw = reserved.reservedKw;
      const swapResult = attemptSwapRestore(
        cycle,
        lane.onDevices,
        dev,
        reserved.availableKw - reservedHeadroomKw,
        { needed, devPower: nextStep.planningPowerW / 1000, penaltyLevel: 0, penaltyExtraKw: 0 },
        restoreDebugKey,
        {
          admitted: {
            desiredStepId: nextStep.id,
            expectedPowerKw: nextStep.planningPowerW / 1000,
            reason: buildSteppedRestoreNeedReason(dev, nextStep.id, needed),
          },
          rejected: resolveRejectedSteppedSwapUpdate(dev),
        },
      );
      // `no_source` falls through: nothing was running to swap out, so the
      // reject below is the decision, with the step's own shortfall figures.
      if (swapResult.kind === 'decided') {
        return {
          availableHeadroom: swapResult.availableHeadroom + reservedHeadroomKw,
          restoredOneThisCycle: restoredOneThisCycle || swapResult.restoredOneThisCycle,
        };
      }
    }
    return rejectSteppedRestoreForInsufficientHeadroom(cycle, dev, loop, nextStep, shedDeviceCount, reserved, need);
  }
  const admittedLog = buildReserveAdmittedLogFields(reserved);
  setRestorePlanDevice(deviceMap, dev.id, {
    desiredStepId: nextStep.id,
    expectedPowerKw: nextStep.planningPowerW / 1000,
    reason: buildSteppedRestoreNeedReason(dev, nextStep.id, needed),
  });
  emitRestoreDebugEventOnChange({
    state,
    key: restoreDebugKey,
    payload: {
      event: 'restore_stepped_admitted',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId,
      toStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep?.id,
      blockedByShedInvariant: false,
      shedDeviceCount,
      deltaKw,
      neededKw: needed,
      availableKw: admittedLog.effectiveHeadroomKw,
      marginKw: admittedLog.marginKw,
      decision: 'admitted',
    },
  });
  recordShedPostureRestoreBatchAdmission(
    batchState,
    state.shedDecisions,
    dev.id,
    needed,
  );
  return { availableHeadroom: spendPowerHeadroom(availableHeadroom, needed), restoredOneThisCycle: true };
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function blockSteppedRestoreForShedInvariant(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice,
  nextStep: SteppedLoadStep,
): boolean {
  const { deviceMap, state, phase } = cycle;
  // Boost is the user's priority override: it bypasses the fairness invariant.
  // No draw-evidence consult here — `resolveBoostActive` already released the
  // boost if the device is drawing nothing, so an active boost IS a device with
  // demand. Re-asking would also break the staircase case a second time: a
  // freshly-entered rung has no accepted calibration samples of its own (see the
  // regression in planRestoreBoostShedInvariantBypass.test.ts).
  if (dev.boostActive) return false;
  const lowestNonZeroStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
  if (!lowestNonZeroStep || nextStep.planningPowerW <= lowestNonZeroStep.planningPowerW) return false;
  const shedDeviceCount = countShedDevices(deviceMap, dev.id, state.shedDecisions);
  if (shedDeviceCount === 0) return false;
  const reason = {
    code: PLAN_REASON_CODES.shedInvariant,
    fromStep: dev.selectedStepId,
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
      key: `stepped:${dev.id}`,
      payload: {
        event: 'restore_stepped_rejected',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        currentStepId: dev.selectedStepId,
        requestedStepId: nextStep.id,
        lowestNonZeroStepId: lowestNonZeroStep.id,
        allowedMaxStepId: lowestNonZeroStep.id,
        blockedByShedInvariant: true,
        shedDeviceCount,
        decision: 'rejected',
        rejectionReason: 'shed_invariant',
      },
    });
    state.steppedRestoreRejectedByDevice[dev.id] = {
      requestedStepId: nextStep.id,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      shedDeviceCount,
    };
  }
  return true;
}
/* eslint-enable functional/immutable-data */

function canUseSwapForSteppedRestore(
  dev: SteppedPlanDevice,
  nextStep: SteppedLoadStep,
  lowestNonZeroStep: SteppedLoadStep | null,
): boolean {
  if (lowestNonZeroStep === null) return false;
  if (isOffSteppedRestoreCandidate(dev) && nextStep.id === lowestNonZeroStep.id) return true;
  // Pausing a running lower-priority device to feed a boosted one is only worth
  // it if the boosted device will actually take the load. That used to be a
  // second, swap-only draw-evidence gate here; it is now the release inside
  // `resolveBoostActive`, so a device idling at its setpoint has no boost left
  // to swap on and the question is answered once for every consumer.
  return dev.boostActive;
}

function rejectSteppedRestoreForInsufficientHeadroom(
  cycle: RestoreCycle,
  dev: SteppedPlanDevice,
  loop: RestoreLoopState,
  nextStep: SteppedLoadStep,
  shedDeviceCount: number,
  reserved: ReserveInsufficient,
  need: SteppedRestoreNeed,
): RestoreLoopState {
  const { deviceMap, state, phase } = cycle;
  const { admission, availableKw: availableHeadroom } = reserved;
  const reason = buildRestoreHeadroomReason({
    neededKw: need.neededKw,
    availableKw: availableHeadroom,
    marginKw: admission.marginKw,
  });
  setRestorePlanDevice(deviceMap, dev.id, buildSteppedRestoreHoldUpdate(dev, reason));
  emitRestoreDebugEventOnChange({
    state,
    key: `stepped:${dev.id}`,
    payload: {
      event: 'restore_stepped_rejected',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      currentStepId: dev.selectedStepId,
      requestedStepId: nextStep.id,
      lowestNonZeroStepId: getSteppedLoadLowestActiveStep(dev.steppedLoadProfile)?.id,
      blockedByShedInvariant: false,
      shedDeviceCount,
      neededKw: need.neededKw,
      availableKw: availableHeadroom,
      marginKw: admission.marginKw,
      decision: 'rejected',
      rejectionReason: 'insufficient_headroom',
    },
  });
  return loop;
}
