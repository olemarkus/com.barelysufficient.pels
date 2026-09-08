import type { DeviceDiagnosticsRecorder } from '../../diagnostics/deviceDiagnosticsService';
import type { DevicePlanDevice } from '../planTypes';
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
  nowTs: number,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
): RestoreNeed {
  const { power: devPower, needed: baseNeeded } = computeBaseRestoreNeed(dev);
  const recentShedNeeded = applyRecentShedInflation({
    baseNeededKw: baseNeeded,
    lastDeviceShedMs: state.actuation.lastDeviceShedMs[dev.id],
    nowMs: nowTs,
  });
  const penaltyInfo = syncActivationPenaltyState(state, dev.id, nowTs, dev);
  if (penaltyInfo.transition) {
    diagnostics?.recordActivationTransition(penaltyInfo.transition, { name: dev.name });
  }
  const penalty = applyActivationPenalty(recentShedNeeded, penaltyInfo.penaltyLevel);
  return {
    needed: penalty.requiredKwWithPenalty,
    devPower,
    penaltyLevel: penaltyInfo.penaltyLevel,
    penaltyExtraKw: penalty.penaltyExtraKw,
  };
}
