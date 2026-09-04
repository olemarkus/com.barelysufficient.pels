import type { DeviceDiagnosticsRecorder } from '../../diagnostics/deviceDiagnosticsService';
import type { DevicePlanDevice } from '../planTypes';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import type { PlanEngineState } from '../planState';
import {
  applyActivationPenalty,
  syncActivationPenaltyState,
} from '../admission';
import {
  applyRecentShedInflation,
  computeBaseRestoreNeed,
} from './accounting';


/**
 * What one device needs to be restored: the kW it would draw, the kW admission
 * must find, and the activation penalty inflating the latter. Named because
 * five signatures across the restore pass were re-spelling it inline.
 */
export type RestoreNeed = {
  needed: number;
  devPower: number;
  penaltyLevel: number;
  penaltyExtraKw: number;
};

export function getRestoreNeed(
  dev: DevicePlanDevice,
  state: PlanEngineState,
  diagnostics?: DeviceDiagnosticsRecorder,
): RestoreNeed {
  const { power: devPower, needed: baseNeeded } = computeBaseRestoreNeed(dev);
  const recentShedNeeded = applyRecentShedInflation({
    baseNeededKw: baseNeeded,
    lastDeviceShedMs: state.lastDeviceShedMs[dev.id],
    nowMs: Date.now(),
  });
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId: dev.id,
    observation: {
      available: dev.available,
      // Binary status follows control-capability presence (drop revokes it).
      // `currentOn` (the on/off truth) is forwarded for the activation in/active reads.
      ...(isBinaryPlanDevice(dev) ? { currentOn: dev.currentOn } : {}),
      currentState: dev.currentState,
      currentDrawKw: dev.currentDrawKw,
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
