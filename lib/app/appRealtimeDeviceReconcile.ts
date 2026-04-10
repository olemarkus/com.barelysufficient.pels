import type { RealtimeDeviceReconcileChange } from '../core/deviceManagerRuntime';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';

export const REALTIME_DEVICE_RECONCILE_DEBOUNCE_MS = 250;
const REALTIME_DEVICE_RECONCILE_CONFLICT_WINDOW_MS = 30 * 1000;
const REALTIME_DEVICE_RECONCILE_CONFLICT_THRESHOLD = 3;
const REALTIME_DEVICE_RECONCILE_SUPPRESS_MS = 60 * 1000;

export type RealtimeDeviceReconcileEvent = {
  deviceId: string;
  name: string;
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
  pendingEvents: Map<string, RealtimeDeviceReconcileEvent>;
  circuitState: Map<string, RealtimeDeviceReconcileCircuitState>;
};

export function createRealtimeDeviceReconcileState(): RealtimeDeviceReconcileState {
  return {
    pendingEvents: new Map<string, RealtimeDeviceReconcileEvent>(),
    circuitState: new Map<string, RealtimeDeviceReconcileCircuitState>(),
  };
}

export function clearRealtimeDeviceReconcileState(state: RealtimeDeviceReconcileState): void {
  state.pendingEvents.clear();
  state.circuitState.clear();
}

export function scheduleRealtimeDeviceReconcile(params: {
  state: RealtimeDeviceReconcileState;
  hasPendingTimer: boolean;
  event: RealtimeDeviceReconcileEvent;
  debugStructured?: StructuredDebugEmitter;
  onTimerFired: () => void;
  onFlush: () => Promise<void>;
  onError: (error: unknown) => void;
}): ReturnType<typeof setTimeout> | undefined {
  const {
    state,
    hasPendingTimer,
    event,
    debugStructured,
    onTimerFired,
    onFlush,
    onError,
  } = params;
  debugStructured?.({
    event: 'realtime_reconcile_queued',
    ...toRealtimeReconcileEventPayload(event),
  });
  state.pendingEvents.set(event.deviceId, event);
  if (hasPendingTimer) return undefined;
  return setTimeout(() => {
    onTimerFired();
    onFlush().catch(onError);
  }, REALTIME_DEVICE_RECONCILE_DEBOUNCE_MS);
}

export async function flushRealtimeDeviceReconcileQueue(params: {
  state: RealtimeDeviceReconcileState;
  reconcile: () => Promise<boolean>;
  shouldRecordAttempt?: (event: RealtimeDeviceReconcileEvent) => boolean;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
}): Promise<void> {
  const {
    state,
    reconcile,
    shouldRecordAttempt,
    structuredLog,
    debugStructured,
  } = params;
  const pendingEvents = Array.from(state.pendingEvents.values());
  state.pendingEvents.clear();
  if (pendingEvents.length === 0) return;

  const now = Date.now();
  const eligibleEvents = pendingEvents.filter((event) => !isRealtimeDeviceReconcileSuppressed({
    state,
    event,
    now,
    debugStructured,
  }));
  if (eligibleEvents.length === 0) return;

  const reconciled = await reconcile();
  if (!reconciled) return;
  const attemptedEvents = shouldRecordAttempt
    ? eligibleEvents.filter((event) => shouldRecordAttempt(event))
    : eligibleEvents;
  if (attemptedEvents.length === 0) return;
  structuredLog?.info({
    event: 'realtime_reconcile_applied',
    deviceCount: attemptedEvents.length,
    devices: attemptedEvents.map((event) => toRealtimeReconcileEventSummary(event)),
  });
  recordRealtimeDeviceReconcileAttempts({
    state,
    events: attemptedEvents,
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
  debugStructured?.({
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
    structuredLog?.info({
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
    deviceName: event.name,
    capabilityId: event.capabilityId,
    planExpectation: event.planExpectation,
    changes: event.changes,
  };
}

function toRealtimeReconcileEventSummary(event: RealtimeDeviceReconcileEvent): Record<string, unknown> {
  return {
    deviceId: event.deviceId,
    deviceName: event.name,
    capabilityId: event.capabilityId,
  };
}
