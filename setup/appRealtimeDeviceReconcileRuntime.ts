import {
  flushRealtimeDeviceReconcileQueue,
  scheduleRealtimeDeviceReconcile,
  type RealtimeDeviceReconcileEvent,
  type RealtimeDeviceReconcileState,
} from './appRealtimeDeviceReconcile';
import {
  syncExternalOffHoldForDevice,
  toExternalOffHoldObservedDevice,
} from './externalOffHoldDetection';
import type { ExternalOffHoldReconcileHooks } from './externalOffHoldDetection';
import { isTemperaturePlanDevice } from '../lib/plan/planTemperatureDevice';
import type { AppContext } from '../lib/app/appContext';
import type { DevicePlan } from '../lib/plan/planTypes';
import { MAIN_HOME_ID, type HomeId } from '../lib/utils/settingsKeys';
import type { RealtimeReconcileHooks } from './homeRuntime/createHomeCapacityBundle';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../lib/logging/logger';
import { normalizeError } from '../lib/utils/errorUtils';

/**
 * Structural slice of the home-runtime registry the reconcile router consumes
 * (multi-home R7b P1#1). Kept structural so this module needs no value import of
 * `HomeRuntimeRegistry` — the wiring passes the registry (or `undefined` before
 * `initHomeRuntimeRegistry`, and for the no-sub-homes case).
 */
type RealtimeReconcileRouter = {
  getReconcileRouteForDevice: (deviceId: string) => {
    homeId: HomeId;
    hooks: RealtimeReconcileHooks;
  } | undefined;
};

/**
 * App-flavored wrapper over {@link scheduleAppRealtimeDeviceReconcile}: binds
 * the ctx closures (plan snapshot for the log field, rebuild request) and the
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
  const subHomeRoute = params.getHomeRuntimeRegistry?.()?.getReconcileRouteForDevice(event.deviceId);
  const subHomeHooks = subHomeRoute?.hooks;
  const queueKey = subHomeRoute?.homeId ?? MAIN_HOME_ID;
  // Preserve the historical main timer name; only sub-homes need scoped slots.
  const timerKey = subHomeRoute === undefined
    ? 'realtimeDeviceReconcile'
    : `realtimeDeviceReconcile:${subHomeRoute.homeId}`;
  const targetSnapshotForEvent = perEventCache(() => ctx.latestTargetSnapshot);
  const getLatestPlanSnapshot = subHomeHooks?.getLatestPlanSnapshot
    ?? ((): DevicePlan | null => ctx.planService?.getLatestPlanSnapshot() ?? null);
  const requestRebuild = subHomeHooks?.requestRebuild
    ?? (async (): Promise<string[]> => {
      const outcome = await ctx.planService?.rebuildPlanFromCache('device_observation_changed');
      return outcome?.writtenDeviceIds ?? [];
    });
  if (applyExternalOffHoldToReconcile({
    ctx,
    event,
    observedDevice: toExternalOffHoldObservedDevice(
      targetSnapshotForEvent.read().find((device) => device.id === event.deviceId),
    ),
    hooks: buildExternalOffHoldHooks(ctx, subHomeHooks),
    structuredLog,
    debugStructured,
  })) {
    targetSnapshotForEvent.release();
    return;
  }
  const timer = scheduleAppRealtimeDeviceReconcile({
    event,
    state,
    queueKey,
    hasPendingTimer: timers.has(timerKey),
    getLatestPlanSnapshot,
    structuredLog,
    debugStructured,
    requestRebuild,
    onTimerFired: () => {
      timers.clear(timerKey);
    },
    onError: (error) => {
      structuredLog?.error({
        event: 'realtime_reconcile_failed',
        err: normalizeError(error),
      });
    },
  });
  // Release before the debounced flush can run: the cache is scoped to this
  // event's synchronous phase, and the flush executes later against whatever the
  // world looks like then.
  targetSnapshotForEvent.release();
  if (timer) {
    timers.registerTimeout(timerKey, timer);
  }
}

/**
 * A getter that evaluates its source at most once until {@link release} is
 * called. Used to deduplicate the expensive plan/live-device reads within one
 * event's synchronous phase without freezing them for the later flush.
 */
function perEventCache<T>(read: () => T): { read: () => T; release: () => void } {
  let cached: { value: T } | null = null;
  return {
    read: () => (cached ??= { value: read() }).value,
    release: () => {
      cached = null;
    },
  };
}

/** Bind the external-off seams to the device's owning home (main when unrouted). */
function buildExternalOffHoldHooks(
  ctx: AppContext,
  subHomeHooks: RealtimeReconcileHooks | undefined,
): ExternalOffHoldReconcileHooks {
  return {
    hasPendingBinaryCommand: subHomeHooks?.hasPendingBinaryCommand
      ?? ((deviceId, capabilityId) => (
        ctx.planEngine?.hasPendingBinaryCommandForCapability(deviceId, capabilityId) === true
      )),
    clearRecentBinaryOffCommand: subHomeHooks?.clearRecentBinaryOffCommand
      ?? ((deviceId, capabilityId) => {
        ctx.planEngine?.clearRecentBinaryOffCommandForCapability(deviceId, capabilityId);
      }),
    rebuild: subHomeHooks?.rebuild
      ?? ((reason: string) => ctx.planService?.rebuildPlanFromCache(reason) ?? Promise.resolve()),
  };
}

/**
 * Resolves "Leave off until turned on again" for this event, BEFORE anything is
 * queued, and reports whether the caller must stop without requesting a rebuild.
 *
 * Both outcomes suppress and rebuild. `started`, because the reconcile this
 * event would queue is exactly the stale-plan ON command the hold exists to
 * prevent. `cleared`, because the stale plan still says the device is inactive
 * while it is now observed ON — reconciling that would command it straight back
 * off, moments after the user turned it on. The rebuild re-plans it under
 * current conditions, which may legitimately limit it again.
 *
 * Every seam is routed to the device's OWNING home: pending commands, live
 * devices, and the rebuild. Main and each sub-home keep their
 * own plan engine and service, so asking main's about a sub-home device reports
 * "no pending command" for PELS's own write (fabricating a hold) and rebuilds a
 * plan that does not contain the device.
 */
function applyExternalOffHoldToReconcile(params: {
  ctx: AppContext;
  event: RealtimeDeviceReconcileEvent;
  observedDevice: ReturnType<typeof toExternalOffHoldObservedDevice>;
  hooks: ExternalOffHoldReconcileHooks;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    ctx, event, observedDevice, hooks, structuredLog, debugStructured,
  } = params;
  if (!ctx.externalOffHold) return false;
  const outcome = syncExternalOffHoldForDevice({
    deps: {
      policy: ctx.externalOffHold,
      hasPendingBinaryCommand: hooks.hasPendingBinaryCommand,
      clearRecentBinaryOffCommand: hooks.clearRecentBinaryOffCommand,
      debugStructured,
    },
    deviceId: event.deviceId,
    observedDevice,
    changes: event.changes,
  });
  if (outcome === 'none') return false;
  void hooks.rebuild(
    outcome === 'started' ? 'external_off_hold_started' : 'external_off_hold_cleared',
  ).catch((error: unknown) => {
    structuredLog?.error({
      event: 'external_off_hold_rebuild_failed',
      err: normalizeError(error),
    });
  });
  return true;
}

/**
 * Queues a plan rebuild for a device whose observed control state moved.
 *
 * There is no drift gate here any more. Asking "does this device disagree with
 * the committed plan?" made the wiring layer re-derive a planner comparison
 * (inversion #2), and the answer was only ever used to decide whether to trigger
 * a re-assert of that same committed plan. The producer has already filtered to
 * control-relevant capability changes (`observedControlStateChanged`), and a
 * rebuild re-decides from current device state and whole-home usage — including
 * deciding to do nothing, which is the case the gate used to short-circuit.
 *
 * The cost of dropping the gate is bounded by the coalescing debounce plus the
 * rebuild floor in `appRealtimeDeviceReconcile.ts`, not by the gate.
 */
export function scheduleAppRealtimeDeviceReconcile(params: {
  event: RealtimeDeviceReconcileEvent;
  state: RealtimeDeviceReconcileState;
  queueKey: string;
  hasPendingTimer: boolean;
  getLatestPlanSnapshot: () => DevicePlan | null;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  requestRebuild: () => Promise<string[]>;
  onTimerFired: () => void;
  onError: (error: unknown) => void;
}): ReturnType<typeof setTimeout> | undefined {
  const {
    event,
    state,
    queueKey,
    hasPendingTimer,
    getLatestPlanSnapshot,
    structuredLog,
    debugStructured,
    requestRebuild,
    onTimerFired,
    onError,
  } = params;
  // The plan snapshot is read for the LOG field only — what the plan currently
  // expects, so a reader can see what moved against what. No decision reads it.
  const eventWithPlanExpectation = enrichRealtimeDeviceReconcileEvent(event, getLatestPlanSnapshot());

  return scheduleRealtimeDeviceReconcile({
    state,
    queueKey,
    hasPendingTimer,
    event: eventWithPlanExpectation,
    debugStructured,
    onTimerFired,
    onFlush: async () => {
      await flushRealtimeDeviceReconcileQueue({
        state,
        queueKey,
        requestRebuild,
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
