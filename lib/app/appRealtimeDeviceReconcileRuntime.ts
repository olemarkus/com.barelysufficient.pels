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
  const eventWithPlanExpectation = enrichRealtimeDeviceReconcileEvent(event, latestPlanSnapshot);
  const hasDrift = hasRealtimeDeviceReconcileDrift({
    event: eventWithPlanExpectation,
    latestPlanSnapshot,
    liveDevices,
  });
  if (hasDrift) return true;

  logDebug(
    `Realtime device change matches current plan, skipping reconcile: `
    + formatRealtimeDeviceReconcileEvent(eventWithPlanExpectation),
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
  const eventWithPlanExpectation = enrichRealtimeDeviceReconcileEvent(event, getLatestPlanSnapshot());
  if (!shouldQueueRealtimeDeviceReconcile({
    event: eventWithPlanExpectation,
    latestPlanSnapshot: getLatestPlanSnapshot(),
    liveDevices: getLiveDevices(),
    logDebug,
  })) {
    return undefined;
  }

  return scheduleRealtimeDeviceReconcile({
    state,
    hasPendingTimer,
    event: eventWithPlanExpectation,
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

function enrichRealtimeDeviceReconcileEvent(
  event: RealtimeDeviceReconcileEvent,
  latestPlanSnapshot: DevicePlan | null,
): RealtimeDeviceReconcileEvent {
  const planDevice = latestPlanSnapshot?.devices.find((device) => device.id === event.deviceId);
  if (!planDevice) return event;

  let planExpectation: string | undefined;
  if (
    event.capabilityId?.startsWith('target_temperature')
    && typeof planDevice.plannedTarget === 'number'
  ) {
    planExpectation = `plan target: ${planDevice.plannedTarget}°C`;
  } else if (event.capabilityId === 'onoff' || event.capabilityId === 'evcharger_charging') {
    planExpectation = resolvePlanStateExpectation(planDevice);
  }

  if (!planExpectation) return event;
  return {
    ...event,
    planExpectation,
  };
}

function resolvePlanStateExpectation(
  device: DevicePlan['devices'][number],
): string | undefined {
  if (device.plannedState === 'keep') return 'plan state: on';
  if (device.plannedState === 'shed' && device.shedAction !== 'set_temperature') {
    return 'plan state: off';
  }
  return undefined;
}
