import {
  formatRealtimeDeviceReconcileEvent,
  flushRealtimeDeviceReconcileQueue,
  scheduleRealtimeDeviceReconcile,
  type RealtimeDeviceReconcileEvent,
  type RealtimeDeviceReconcileState,
} from './appRealtimeDeviceReconcile';
import { hasPlanExecutionDriftForDevice } from '../plan/planReconcileState';
import type { DevicePlan, PlanInputDevice } from '../plan/planTypes';

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
  if (!latestPlanSnapshot) return true;

  const hasDrift = hasPlanExecutionDriftForDevice(latestPlanSnapshot, liveDevices, event.deviceId);
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
  latestPlanSnapshot: DevicePlan | null;
  liveDevices: PlanInputDevice[];
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
    latestPlanSnapshot,
    liveDevices,
    logDebug,
    log,
    reconcile,
    onTimerFired,
    onError,
  } = params;
  if (!shouldQueueRealtimeDeviceReconcile({
    event,
    latestPlanSnapshot,
    liveDevices,
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
        logDebug,
        log,
      });
    },
    onError,
  });
}
