import {
  flushRealtimeDeviceReconcileQueue,
  scheduleRealtimeDeviceReconcile,
  toRealtimeReconcileEventPayload,
  type RealtimeDeviceReconcileEvent,
  type RealtimeDeviceReconcileState,
} from './appRealtimeDeviceReconcile';
import { evictMissingDeviceCacheEntries, toPlanDevice } from './appInit/toPlanDevice';
import { hasPlanExecutionDriftForDevice } from '../lib/executor/planExecutionDrift';
import { isTemperaturePlanDevice } from '../lib/plan/planTemperatureDevice';
import type { AppContext } from '../lib/app/appContext';
import type { DevicePlan, PlanInputDevice } from '../lib/plan/planTypes';
import type { RealtimeReconcileHooks } from './homeRuntime/createHomeCapacityBundle';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../lib/logging/logger';
import { getLogger } from '../lib/logging/logger';
import { normalizeError } from '../lib/utils/errorUtils';

const moduleLogger = getLogger('app/realtime-reconcile-runtime');

/**
 * Structural slice of the home-runtime registry the reconcile router consumes
 * (multi-home R7b P1#1). Kept structural so this module needs no value import of
 * `HomeRuntimeRegistry` — the wiring passes the registry (or `undefined` before
 * `initHomeRuntimeRegistry`, and for the no-sub-homes case).
 */
type RealtimeReconcileRouter = {
  getReconcileHooksForDevice: (deviceId: string) => RealtimeReconcileHooks | undefined;
};

/**
 * App-flavored wrapper over {@link scheduleAppRealtimeDeviceReconcile}: binds
 * the ctx closures (plan snapshot, live plan devices, reconcile call) and the
 * shared `realtimeDeviceReconcile` timer-registry slot. Body extracted from
 * `AppServiceWiring.scheduleRealtimeDeviceReconcile` (which stays as a thin
 * method so emitter subscriptions and test seams keep their call site).
 */
export function scheduleAppRealtimeDeviceReconcileForApp(params: {
  ctx: AppContext;
  event: RealtimeDeviceReconcileEvent;
  state: RealtimeDeviceReconcileState;
  timers: TimerRegistry;
  /**
   * Owning-home router (R7b P1#1). When the drifting device belongs to a
   * sub-home, its bundle's reconcile hooks are bound instead of main's. Absent
   * (or resolving `undefined`) — the no-sub-homes case, a main-home device, or
   * the pre-`initHomeRuntimeRegistry` window — the main closures are used,
   * byte-identical to the single-home path.
   */
  getHomeRuntimeRegistry?: () => RealtimeReconcileRouter | undefined;
}): void {
  const { ctx, event, state, timers } = params;
  const structuredLog = ctx.getStructuredLogger('reconcile');
  const debugStructured = ctx.getStructuredDebugEmitter('reconcile', 'devices');
  // Route to the OWNING sub-home bundle when the device belongs to one; the
  // fallback closures are the exact main-home closures used before R7b.
  const subHomeHooks = params.getHomeRuntimeRegistry?.()?.getReconcileHooksForDevice(event.deviceId);
  const getLatestPlanSnapshot = subHomeHooks?.getLatestPlanSnapshot
    ?? ((): DevicePlan | null => ctx.planService?.getLatestReconcilePlanSnapshot() ?? null);
  const getLiveDevices = subHomeHooks?.getLiveDevices ?? ((): PlanInputDevice[] => {
    const snapshot = ctx.latestTargetSnapshot;
    evictMissingDeviceCacheEntries(ctx, snapshot);
    return snapshot.map((device) => toPlanDevice(ctx, device));
  });
  const reconcile = subHomeHooks?.reconcile
    ?? ((): Promise<boolean> => ctx.planService?.reconcileLatestPlanState() ?? Promise.resolve(false));
  const timer = scheduleAppRealtimeDeviceReconcile({
    event,
    state,
    hasPendingTimer: timers.has('realtimeDeviceReconcile'),
    getLatestPlanSnapshot,
    getLiveDevices,
    structuredLog,
    debugStructured,
    reconcile,
    onTimerFired: () => {
      timers.clear('realtimeDeviceReconcile');
    },
    onError: (error) => {
      structuredLog?.error({
        event: 'realtime_reconcile_failed',
        err: normalizeError(error),
      });
    },
  });
  if (timer) {
    timers.registerTimeout('realtimeDeviceReconcile', timer);
  }
}

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
  return hasPlanExecutionDriftForDevice({
    plan: latestPlanSnapshot,
    liveDevices,
    deviceId: event.deviceId,
  });
}

export function shouldQueueRealtimeDeviceReconcile(params: {
  event: RealtimeDeviceReconcileEvent;
  latestPlanSnapshot: DevicePlan | null;
  liveDevices: PlanInputDevice[];
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    event,
    latestPlanSnapshot,
    liveDevices,
    debugStructured,
  } = params;
  const eventWithPlanExpectation = enrichRealtimeDeviceReconcileEvent(event, latestPlanSnapshot);
  const hasDrift = hasRealtimeDeviceReconcileDrift({
    event: eventWithPlanExpectation,
    latestPlanSnapshot,
    liveDevices,
  });
  if (hasDrift) return true;

  (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
    event: 'realtime_reconcile_skipped_no_drift',
    ...toRealtimeReconcileEventPayload(eventWithPlanExpectation),
  });
  return false;
}

export function scheduleAppRealtimeDeviceReconcile(params: {
  event: RealtimeDeviceReconcileEvent;
  state: RealtimeDeviceReconcileState;
  hasPendingTimer: boolean;
  getLatestPlanSnapshot: () => DevicePlan | null;
  getLiveDevices: () => PlanInputDevice[];
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
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
    structuredLog,
    debugStructured,
    reconcile,
    onTimerFired,
    onError,
  } = params;
  const eventWithPlanExpectation = enrichRealtimeDeviceReconcileEvent(event, getLatestPlanSnapshot());
  if (!shouldQueueRealtimeDeviceReconcile({
      event: eventWithPlanExpectation,
      latestPlanSnapshot: getLatestPlanSnapshot(),
      liveDevices: getLiveDevices(),
      debugStructured,
    })) {
    return undefined;
  }

  return scheduleRealtimeDeviceReconcile({
    state,
    hasPendingTimer,
    event: eventWithPlanExpectation,
    debugStructured,
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
        structuredLog,
        debugStructured,
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
  const plannedTarget = isTemperaturePlanDevice(planDevice) ? planDevice.plannedTarget : undefined;
  if (
    event.capabilityId?.startsWith('target_temperature')
    && typeof plannedTarget === 'number'
  ) {
    planExpectation = `plan target: ${plannedTarget}°C`;
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
