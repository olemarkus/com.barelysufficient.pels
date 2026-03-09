import {
  formatRealtimeDeviceReconcileEvent,
  flushRealtimeDeviceReconcileQueue,
  scheduleRealtimeDeviceReconcile,
  type RealtimeDeviceReconcileEvent,
  type RealtimeDeviceReconcileState,
} from './appRealtimeDeviceReconcile';
import { hasPlanExecutionDriftForDevice } from '../plan/planReconcileState';
import type { DevicePlan, PlanInputDevice } from '../plan/planTypes';

export function hasRealtimeDeviceReconcileDrift(params: {
  event: RealtimeDeviceReconcileEvent;
  latestPlanSnapshot: DevicePlan | null;
  liveDevices: PlanInputDevice[];
}): boolean {
  const {
    event,
    latestPlanSnapshot,
    liveDevices,
  } = params;
  if (!latestPlanSnapshot) return true;
  return hasPlanExecutionDriftForDevice(latestPlanSnapshot, liveDevices, event.deviceId);
}

export function shouldQueueRealtimeDeviceReconcile(params: {
  event: RealtimeDeviceReconcileEvent;
  latestPlanSnapshot: DevicePlan | null;
  liveDevices: PlanInputDevice[];
  logDebug: (message: string) => void;
}): boolean {
  const {
    event,
    latestPlanSnapshot,
    liveDevices,
    logDebug,
  } = params;
  const hasDrift = hasRealtimeDeviceReconcileDrift({
    event,
    latestPlanSnapshot,
    liveDevices,
  });
  if (hasDrift) return true;

  logDebug(
    `Realtime device change matches current plan, skipping reconcile: `
    + formatRealtimeDeviceReconcileEvent(event),
  );
  return false;
}

export function scheduleAppRealtimeDeviceReconcile(params: {
  event: RealtimeDeviceReconcileEvent;
  state: RealtimeDeviceReconcileState;
  hasPendingTimer: boolean;
  getLatestPlanSnapshot: () => DevicePlan | null;
  getLiveDevices: () => PlanInputDevice[];
  logDebug: (message: string) => void;
  log: (message: string) => void;
  reconcile: () => Promise<boolean>;
  onTimerFired: () => void;
  onError: (error: unknown) => void;
}): ReturnType<typeof setTimeout> | undefined {
  const {
    event,
    state,
    hasPendingTimer,
    getLatestPlanSnapshot,
    getLiveDevices,
    logDebug,
    log,
    reconcile,
    onTimerFired,
    onError,
  } = params;
  if (!shouldQueueRealtimeDeviceReconcile({
    event,
    latestPlanSnapshot: getLatestPlanSnapshot(),
    liveDevices: getLiveDevices(),
    logDebug,
  })) {
    return undefined;
  }

  return scheduleRealtimeDeviceReconcile({
    state,
    hasPendingTimer,
    event,
    logDebug,
    onTimerFired,
    onFlush: async () => {
      await flushRealtimeDeviceReconcileQueue({
        state,
        reconcile,
        shouldRecordAttempt: (nextEvent) => hasRealtimeDeviceReconcileDrift({
          event: nextEvent,
          latestPlanSnapshot: getLatestPlanSnapshot(),
          liveDevices: getLiveDevices(),
        }),
        logDebug,
        log,
      });
    },
    onError,
  });
}
