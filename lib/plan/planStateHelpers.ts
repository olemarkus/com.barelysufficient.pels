import { RECENT_SHED_RESTORE_BACKOFF_MS } from './planConstants';
import type { PlanEngineState } from './planState';

type PlanConvergenceState = Pick<
  PlanEngineState,
  | 'wasOvershoot'
  | 'lastInstabilityMs'
  | 'lastRecoveryMs'
  | 'lastRestoreMs'
  | 'lastDeviceShedMs'
  | 'lastDeviceRestoreMs'
  | 'pendingSheds'
  | 'pendingRestores'
  | 'pendingTargetCommands'
  | 'pendingBinaryCommands'
>;

const isRecent = (timestamp: number | null | undefined, nowMs: number, recentWindowMs: number): boolean => (
  typeof timestamp === 'number'
  && timestamp > 0
  && timestamp <= nowMs
  && (nowMs - timestamp) <= recentWindowMs
);

const hasRecentDeviceTimestamps = (
  timestamps: PlanConvergenceState['lastDeviceShedMs'] | PlanConvergenceState['lastDeviceRestoreMs'],
  nowMs: number,
  recentWindowMs: number,
): boolean => Object.values(timestamps ?? {}).some((timestamp) => isRecent(timestamp, nowMs, recentWindowMs));

const hasPendingPlanWork = (planState: PlanConvergenceState): boolean => (
  (planState.pendingSheds?.size ?? 0) > 0
  || (planState.pendingRestores?.size ?? 0) > 0
  || Object.keys(planState.pendingTargetCommands ?? {}).length > 0
  || Object.keys(planState.pendingBinaryCommands ?? {}).length > 0
);

export function isPlanConverging(
  planState: PlanConvergenceState | null | undefined,
  nowMs: number,
  recentWindowMs: number = RECENT_SHED_RESTORE_BACKOFF_MS,
): boolean {
  if (!planState) return false;
  if (planState.wasOvershoot) return true;
  if (isRecent(planState.lastInstabilityMs, nowMs, recentWindowMs)) return true;
  if (isRecent(planState.lastRecoveryMs, nowMs, recentWindowMs)) return true;
  if (isRecent(planState.lastRestoreMs, nowMs, recentWindowMs)) return true;
  if (hasRecentDeviceTimestamps(planState.lastDeviceShedMs, nowMs, recentWindowMs)) return true;
  if (hasRecentDeviceTimestamps(planState.lastDeviceRestoreMs, nowMs, recentWindowMs)) return true;
  return hasPendingPlanWork(planState);
}
