import type { StructuredDebugEmitter } from '../logging/logger';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import {
  RECENT_SHED_EXTRA_BUFFER_KW,
  RECENT_SHED_RESTORE_BACKOFF_MS,
  RECENT_SHED_RESTORE_MULTIPLIER,
} from './planConstants';
import {
  applyActivationPenalty,
  syncActivationPenaltyState,
} from './planActivationBackoff';
import { computeBaseRestoreNeed, computePendingRestorePowerKw } from './planRestoreSwap';

export function reserveHeadroomForPendingRestores(
  rawHeadroom: number,
  planDevices: DevicePlanDevice[],
  lastDeviceRestoreMs: Record<string, number>,
  debugStructured: StructuredDebugEmitter | undefined,
  deviceNameById: ReadonlyMap<string, string> | undefined,
): number {
  const pending = computePendingRestorePowerKw(planDevices, lastDeviceRestoreMs, Date.now());
  if (pending.pendingKw <= 0) return rawHeadroom;
  const adjusted = rawHeadroom - pending.pendingKw;
  debugStructured?.({
    event: 'restore_headroom_reserved',
    pendingKw: pending.pendingKw,
    deviceIds: pending.deviceIds,
    deviceNames: pending.deviceIds.map((id) => deviceNameById?.get(id) ?? id),
    headroomAfterKw: adjusted,
  });
  return adjusted;
}

export function getRestoreNeed(
  dev: DevicePlanDevice,
  state: PlanEngineState,
  diagnostics?: DeviceDiagnosticsRecorder,
): { needed: number; devPower: number; penaltyLevel: number; penaltyExtraKw: number } {
  const { power: devPower, needed: baseNeeded } = computeBaseRestoreNeed(dev);
  const lastDeviceShed = state.lastDeviceShedMs[dev.id];
  const recentlyShed = Boolean(
    lastDeviceShed && Date.now() - lastDeviceShed < RECENT_SHED_RESTORE_BACKOFF_MS,
  );
  const recentShedNeeded = recentlyShed
    ? Math.max(baseNeeded * RECENT_SHED_RESTORE_MULTIPLIER, baseNeeded + RECENT_SHED_EXTRA_BUFFER_KW)
    : baseNeeded;
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId: dev.id,
    observation: {
      available: dev.available,
      currentOn: dev.currentOn,
      currentState: dev.currentState,
      measuredPowerKw: dev.measuredPowerKw,
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

export function formatUnknownHeadroomReason(dev: DevicePlanDevice): string {
  const { needed } = computeBaseRestoreNeed(dev);
  return `insufficient headroom (need ${needed.toFixed(2)}kW, headroom unknown)`;
}
