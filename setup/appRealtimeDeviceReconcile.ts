import type { RealtimeDeviceReconcileChange } from '../lib/device/managerRuntime';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../lib/logging/logger';
import { getLogger } from '../lib/logging/logger';

const moduleLogger = getLogger('app/realtime-reconcile');

export const REALTIME_DEVICE_RECONCILE_DEBOUNCE_MS = 250;
/**
 * Floor between two observation-driven rebuilds for the same queue (home),
 * matching `POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS` in `setup/powerSamplePipeline.ts`.
 *
 * A realtime event now requests a full re-plan rather than a re-assert, which
 * costs real work (`SLOW_PLAN_REBUILD_LOG_THRESHOLD_MS` is 1500 ms). The 250 ms
 * debounce alone would let a chatty home drive four rebuilds a second, so a
 * burst is throttled to this floor while an isolated event still lands after the
 * debounce. Losing the old 281 ms reaction time is deliberate: reacting inside
 * the planner's own rebuild interval is exactly what let a re-assert beat the
 * re-decide in inc_26449fb9.
 */
const REALTIME_DEVICE_REBUILD_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;
const REALTIME_DEVICE_RECONCILE_CONFLICT_WINDOW_MS = 30 * 1000;
const REALTIME_DEVICE_RECONCILE_CONFLICT_THRESHOLD = 3;
const REALTIME_DEVICE_RECONCILE_SUPPRESS_MS = 60 * 1000;

export type RealtimeDeviceReconcileEvent = {
  deviceId: string;
  name?: string;
  capabilityId?: string;
  changes?: RealtimeDeviceReconcileChange[];
  planExpectation?: string;
};

type RealtimeDeviceReconcileCircuitState = {
  windowStartedAt: number;
  reconcileCount: number;
  suppressedUntil?: number;
};

export type RealtimeDeviceReconcileState = {
  pendingEventsByQueue: Map<string, Map<string, RealtimeDeviceReconcileEvent>>;
  circuitState: Map<string, RealtimeDeviceReconcileCircuitState>;
  lastRebuildAtMsByQueue: Map<string, number>;
};

export function createRealtimeDeviceReconcileState(): RealtimeDeviceReconcileState {
  return {
    pendingEventsByQueue: new Map<string, Map<string, RealtimeDeviceReconcileEvent>>(),
    circuitState: new Map<string, RealtimeDeviceReconcileCircuitState>(),
    lastRebuildAtMsByQueue: new Map<string, number>(),
  };
}

export function clearRealtimeDeviceReconcileState(state: RealtimeDeviceReconcileState): void {
  state.pendingEventsByQueue.clear();
  state.circuitState.clear();
  state.lastRebuildAtMsByQueue.clear();
}

export function scheduleRealtimeDeviceReconcile(params: {
  state: RealtimeDeviceReconcileState;
  queueKey: string;
  hasPendingTimer: boolean;
  event: RealtimeDeviceReconcileEvent;
  debugStructured?: StructuredDebugEmitter;
  onTimerFired: () => void;
  onFlush: () => Promise<void>;
  onError: (error: unknown) => void;
}): ReturnType<typeof setTimeout> | undefined {
  const {
    state,
    queueKey,
    hasPendingTimer,
    event,
    debugStructured,
    onTimerFired,
    onFlush,
    onError,
  } = params;
  (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
    event: 'realtime_reconcile_queued',
    ...toRealtimeReconcileEventPayload(event),
  });
  const pendingEvents = state.pendingEventsByQueue.get(queueKey)
    ?? new Map<string, RealtimeDeviceReconcileEvent>();
  pendingEvents.set(event.deviceId, event);
  state.pendingEventsByQueue.set(queueKey, pendingEvents);
  if (hasPendingTimer) return undefined;
  return setTimeout(() => {
    onTimerFired();
    onFlush().catch(onError);
  }, resolveRealtimeRebuildDelayMs(state, queueKey));
}

/**
 * Debounce for an isolated event, throttle for a burst: whichever of the 250 ms
 * debounce and the remaining rebuild floor is longer. Coalescing means a burst
 * still collapses into ONE rebuild carrying every device that moved.
 *
 * The result is CLAMPED to the floor because `Date.now()` is not monotonic. An
 * NTP step backwards by N ms makes `sinceMs` negative, which without the clamp
 * arms the timer for `floor + N`. `hasPendingTimer` then blocks re-arming, so
 * every later observation for this home coalesces into that stalled timer and
 * the whole lane goes dark for an unbounded interval — one clock step, one
 * silent home. It self-heals after the timer finally fires; the clamp means it
 * never stalls in the first place.
 */
export function resolveRealtimeRebuildDelayMs(
  state: RealtimeDeviceReconcileState,
  queueKey: string,
): number {
  const lastRebuildAtMs = state.lastRebuildAtMsByQueue.get(queueKey);
  if (lastRebuildAtMs === undefined) return REALTIME_DEVICE_RECONCILE_DEBOUNCE_MS;
  const sinceMs = Date.now() - lastRebuildAtMs;
  const remainingFloorMs = Math.min(
    REALTIME_DEVICE_REBUILD_MIN_INTERVAL_MS,
    REALTIME_DEVICE_REBUILD_MIN_INTERVAL_MS - sinceMs,
  );
  return Math.max(REALTIME_DEVICE_RECONCILE_DEBOUNCE_MS, remainingFloorMs);
}

/**
 * Requests ONE plan rebuild for everything that moved since the last flush.
 *
 * `requestRebuild` resolves the ids of the devices the rebuild actually wrote to
 * (`PlanRebuildOutcome.writtenDeviceIds`). That is the signal the circuit breaker
 * counts, and it is deliberately the only thing this layer knows: "which devices
 * did the rebuild write?" is a fact about the outcome, where the old
 * `shouldRecordAttempt` asked "is this device still drifting from the plan?" —
 * a planner comparison the wiring layer had no business making (inversion #2).
 *
 * It must be the per-device ids and not a plan-wide boolean. One rebuild covers
 * every device that moved, so a bare "something was written" would charge a
 * strike to a device that merely reported a benign change while a DIFFERENT one
 * was actuated — three of those in 30 s and that innocent device's observations
 * are suppressed for a minute. The breaker means "we are fighting THIS device".
 */
export async function flushRealtimeDeviceReconcileQueue(params: {
  state: RealtimeDeviceReconcileState;
  queueKey: string;
  requestRebuild: () => Promise<string[]>;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
}): Promise<void> {
  const {
    state,
    queueKey,
    requestRebuild,
    structuredLog,
    debugStructured,
  } = params;
  const pendingEvents = Array.from(state.pendingEventsByQueue.get(queueKey)?.values() ?? []);
  state.pendingEventsByQueue.delete(queueKey);
  if (pendingEvents.length === 0) return;

  const now = Date.now();
  const eligibleEvents = pendingEvents.filter((event) => !isRealtimeDeviceReconcileSuppressed({
    state,
    event,
    now,
    debugStructured,
  }));
  if (eligibleEvents.length === 0) return;

  // Stamp before awaiting: the floor is about how often we START a rebuild, and
  // a long rebuild must not earn an immediate second one on completion.
  state.lastRebuildAtMsByQueue.set(queueKey, Date.now());
  const writtenDeviceIds = await requestRebuild();
  if (writtenDeviceIds.length === 0) return;

  // The log and the breaker answer different questions, so they take different
  // sets. An observation from device A can legitimately make the planner leave A
  // alone and actuate device B instead — B is a real write and belongs in the
  // log, but B never reported anything, so charging it a strike would suppress a
  // device that was not fighting us. Intersecting both, as this first did, loses
  // the log line entirely for exactly that case: the rebuild acted and nothing
  // said so.
  const chargeableEvents = eligibleEvents.filter(
    (event) => writtenDeviceIds.includes(event.deviceId),
  );
  (structuredLog ?? moduleLogger).info({
    event: 'realtime_observation_rebuild_applied',
    deviceCount: writtenDeviceIds.length,
    devices: chargeableEvents.map((event) => toRealtimeReconcileEventSummary(event)),
    // Everything the rebuild wrote, including devices outside this batch.
    writtenDeviceIds,
  });

  if (chargeableEvents.length === 0) return;
  recordRealtimeDeviceReconcileAttempts({
    state,
    events: chargeableEvents,
    now: Date.now(),
    structuredLog,
  });
}

function isRealtimeDeviceReconcileSuppressed(params: {
  state: RealtimeDeviceReconcileState;
  event: RealtimeDeviceReconcileEvent;
  now: number;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const { state, event, now, debugStructured } = params;
  const currentState = state.circuitState.get(event.deviceId);
  if (!currentState?.suppressedUntil) return false;
  if (currentState.suppressedUntil <= now) {
    state.circuitState.delete(event.deviceId);
    return false;
  }
  const remainingSeconds = Math.max(1, Math.ceil((currentState.suppressedUntil - now) / 1000));
  (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
    event: 'realtime_reconcile_suppressed',
    remainingSeconds,
    ...toRealtimeReconcileEventPayload(event),
  });
  return true;
}

function recordRealtimeDeviceReconcileAttempts(params: {
  state: RealtimeDeviceReconcileState;
  events: RealtimeDeviceReconcileEvent[];
  now: number;
  structuredLog?: PinoLogger;
}): void {
  const { state, events, now, structuredLog } = params;
  for (const event of events) {
    const currentState = getRealtimeDeviceReconcileCircuitState(state, event.deviceId, now);
    const nextState: RealtimeDeviceReconcileCircuitState = {
      ...currentState,
      reconcileCount: currentState.reconcileCount + 1,
    };
    if (nextState.reconcileCount < REALTIME_DEVICE_RECONCILE_CONFLICT_THRESHOLD) {
      state.circuitState.set(event.deviceId, nextState);
      continue;
    }
    const suppressedUntil = now + REALTIME_DEVICE_RECONCILE_SUPPRESS_MS;
    state.circuitState.set(event.deviceId, {
      windowStartedAt: now,
      reconcileCount: 0,
      suppressedUntil,
    });
    (structuredLog ?? moduleLogger).info({
      event: 'realtime_reconcile_circuit_opened',
      suppressMs: REALTIME_DEVICE_RECONCILE_SUPPRESS_MS,
      ...toRealtimeReconcileEventPayload(event),
    });
  }
}

function getRealtimeDeviceReconcileCircuitState(
  state: RealtimeDeviceReconcileState,
  deviceId: string,
  now: number,
): RealtimeDeviceReconcileCircuitState {
  const existingState = state.circuitState.get(deviceId);
  if (!existingState) {
    return { windowStartedAt: now, reconcileCount: 0 };
  }
  if (existingState.suppressedUntil && existingState.suppressedUntil <= now) {
    return { windowStartedAt: now, reconcileCount: 0 };
  }
  if (now - existingState.windowStartedAt > REALTIME_DEVICE_RECONCILE_CONFLICT_WINDOW_MS) {
    return { windowStartedAt: now, reconcileCount: 0 };
  }
  return existingState;
}

export function toRealtimeReconcileEventPayload(event: RealtimeDeviceReconcileEvent): Record<string, unknown> {
  return {
    deviceId: event.deviceId,
    ...(typeof event.name === 'string' && event.name.length > 0 ? { deviceName: event.name } : {}),
    capabilityId: event.capabilityId,
    planExpectation: event.planExpectation,
    changes: event.changes,
  };
}

function toRealtimeReconcileEventSummary(event: RealtimeDeviceReconcileEvent): Record<string, unknown> {
  return {
    deviceId: event.deviceId,
    ...(typeof event.name === 'string' && event.name.length > 0 ? { deviceName: event.name } : {}),
    capabilityId: event.capabilityId,
  };
}
