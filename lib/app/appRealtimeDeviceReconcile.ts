import type { RealtimeDeviceReconcileChange } from '../core/deviceManagerRuntime';
import type { Logger as PinoLogger } from '../logging/logger';

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
  logDebug: (message: string) => void;
  structuredLog?: PinoLogger;
  onTimerFired: () => void;
  onFlush: () => Promise<void>;
  onError: (error: unknown) => void;
}): ReturnType<typeof setTimeout> | undefined {
  const {
    state,
    hasPendingTimer,
    event,
    logDebug,
    structuredLog,
    onTimerFired,
    onFlush,
    onError,
  } = params;
  logDebug(`Realtime device drift queued for plan reconcile: ${formatRealtimeDeviceReconcileEvent(event)}`);
  structuredLog?.debug({
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
  logDebug: (message: string) => void;
  structuredLog?: PinoLogger;
}): Promise<void> {
  const {
    state,
    reconcile,
    shouldRecordAttempt,
    logDebug,
    structuredLog,
  } = params;
  const pendingEvents = Array.from(state.pendingEvents.values());
  state.pendingEvents.clear();
  if (pendingEvents.length === 0) return;

  const now = Date.now();
  const eligibleEvents = pendingEvents.filter((event) => !isRealtimeDeviceReconcileSuppressed({
    state,
    event,
    now,
    logDebug,
    structuredLog,
  }));
  if (eligibleEvents.length === 0) return;

  const reconciled = await reconcile();
  if (!reconciled) return;
  const driftedEvents = shouldRecordAttempt
    ? eligibleEvents.filter((event) => shouldRecordAttempt(event))
    : eligibleEvents;
  const attemptedEvents = driftedEvents.length > 0 ? driftedEvents : eligibleEvents;
  if (attemptedEvents.length === 0) return;
  structuredLog?.warn({
    event: 'realtime_reconcile_applied',
    devices: attemptedEvents.map((event) => toRealtimeReconcileEventPayload(event)),
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
  logDebug: (message: string) => void;
  structuredLog?: PinoLogger;
}): boolean {
  const { state, event, now, logDebug, structuredLog } = params;
  const currentState = state.circuitState.get(event.deviceId);
  if (!currentState?.suppressedUntil) return false;
  if (currentState.suppressedUntil <= now) {
    state.circuitState.delete(event.deviceId);
    return false;
  }
  const remainingSeconds = Math.max(1, Math.ceil((currentState.suppressedUntil - now) / 1000));
  logDebug(
    `Realtime device drift suppressed for ${formatRealtimeDeviceReconcileEvent(event)}; `
    + `${remainingSeconds}s remaining`,
  );
  structuredLog?.debug({
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
    structuredLog?.warn({
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

export function formatRealtimeDeviceReconcileEvent(event: RealtimeDeviceReconcileEvent): string {
  const capabilitySuffix = event.capabilityId ? ` via ${event.capabilityId}` : '';
  const changesSuffix = formatRealtimeDeviceReconcileChanges(event.changes);
  const expectationSuffix = event.planExpectation ? `; ${event.planExpectation}` : '';
  return `${event.name} (${event.deviceId})${capabilitySuffix}${changesSuffix}${expectationSuffix}`;
}

function formatRealtimeDeviceReconcileChanges(
  changes: RealtimeDeviceReconcileChange[] | undefined,
): string {
  if (!changes || changes.length === 0) return '';
  const formatted = changes.map((change) => (
    `${change.capabilityId}: ${change.previousValue} -> ${change.nextValue}`
  ));
  return ` [${formatted.join(', ')}]`;
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
