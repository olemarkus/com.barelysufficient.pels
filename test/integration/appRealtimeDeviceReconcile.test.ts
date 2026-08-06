import {
  createRealtimeDeviceReconcileState,
  flushRealtimeDeviceReconcileQueue,
  scheduleRealtimeDeviceReconcile,
  type RealtimeDeviceReconcileEvent,
} from '../../setup/appRealtimeDeviceReconcile';
import type { Logger, StructuredDebugEmitter } from '../../lib/logging/logger';

/**
 * The queue/debounce/circuit-breaker around observation-driven rebuilds.
 *
 * The drift-gate tests that used to live here are gone with the gate itself: the
 * wiring layer no longer asks whether a device disagrees with the committed plan
 * (that comparison belongs to the executor — see `executorConvergence.test.ts`),
 * it just requests a re-plan and asks the outcome whether anything was written.
 */
describe('appRealtimeDeviceReconcile', () => {
  const QUEUE_KEY = 'main';
  const createDebugStructuredMock = (): StructuredDebugEmitter => vi.fn() as unknown as StructuredDebugEmitter;
  const createInfoLoggerMock = (): Logger & { info: ReturnType<typeof vi.fn> } => (
    { info: vi.fn() } as unknown as Logger & { info: ReturnType<typeof vi.fn> }
  );
  const queueEvent = (
    state: ReturnType<typeof createRealtimeDeviceReconcileState>,
    event: RealtimeDeviceReconcileEvent,
  ): void => {
    const queue = state.pendingEventsByQueue.get(QUEUE_KEY) ?? new Map();
    queue.set(event.deviceId, event);
    state.pendingEventsByQueue.set(QUEUE_KEY, queue);
  };

  it('logs drift details when queueing realtime reconcile', () => {
    vi.useFakeTimers();
    const debugStructured = createDebugStructuredMock();

    const timer = scheduleRealtimeDeviceReconcile({
      state: createRealtimeDeviceReconcileState(),
      queueKey: QUEUE_KEY,
      hasPendingTimer: false,
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
      },
      debugStructured,
      onTimerFired: vi.fn(),
      onFlush: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
    });

    expect(timer).toBeDefined();
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'realtime_reconcile_queued',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      capabilityId: 'onoff',
      planExpectation: undefined,
      changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
    });

    if (timer) clearTimeout(timer);
    vi.useRealTimers();
  });

  it('omits deviceName from reconcile payloads when no label is known', () => {
    vi.useFakeTimers();
    const debugStructured = createDebugStructuredMock();

    const timer = scheduleRealtimeDeviceReconcile({
      state: createRealtimeDeviceReconcileState(),
      queueKey: QUEUE_KEY,
      hasPendingTimer: false,
      event: {
        deviceId: 'dev-1',
        capabilityId: 'onoff',
      },
      debugStructured,
      onTimerFired: vi.fn(),
      onFlush: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
    });

    expect(timer).toBeDefined();
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'realtime_reconcile_queued',
      deviceId: 'dev-1',
      capabilityId: 'onoff',
      planExpectation: undefined,
      changes: undefined,
    });

    if (timer) clearTimeout(timer);
    vi.useRealTimers();
  });

  it('coalesces every queued device into one rebuild and records an attempt for each', async () => {
    const state = createRealtimeDeviceReconcileState();
    const structuredLog = createInfoLoggerMock();
    queueEvent(state, { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });
    queueEvent(state, { deviceId: 'dev-2', name: 'Heater 2', capabilityId: 'onoff' });
    const requestRebuild = vi.fn().mockResolvedValue(true);

    await flushRealtimeDeviceReconcileQueue({
      state,
      queueKey: QUEUE_KEY,
      requestRebuild,
      structuredLog,
    });

    // ONE rebuild covers both devices — it re-plans the whole home, so there is
    // nothing per-device to run.
    expect(requestRebuild).toHaveBeenCalledTimes(1);
    // Both are charged an attempt. The old per-event `shouldRecordAttempt` asked
    // "is this device STILL drifting?", which is a planner comparison the wiring
    // layer had no business making; the rebuild's own "did I write?" answer is
    // what the breaker counts now.
    expect(state.circuitState.get('dev-1')).toEqual(expect.objectContaining({ reconcileCount: 1 }));
    expect(state.circuitState.get('dev-2')).toEqual(expect.objectContaining({ reconcileCount: 1 }));
    expect(structuredLog.info).toHaveBeenCalledWith({
      event: 'realtime_observation_rebuild_applied',
      deviceCount: 2,
      devices: [
        { deviceId: 'dev-1', deviceName: 'Heater 1', capabilityId: 'onoff' },
        { deviceId: 'dev-2', deviceName: 'Heater 2', capabilityId: 'onoff' },
      ],
    });
  });

  it('does not log or record attempts when the rebuild wrote nothing', async () => {
    const state = createRealtimeDeviceReconcileState();
    const structuredLog = createInfoLoggerMock();
    queueEvent(state, { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });

    await flushRealtimeDeviceReconcileQueue({
      state,
      queueKey: QUEUE_KEY,
      // The rebuild ran and decided nothing needed doing — the common case once
      // the gate is gone, and it must not count toward the breaker.
      requestRebuild: vi.fn().mockResolvedValue(false),
      structuredLog,
    });

    expect(structuredLog.info).not.toHaveBeenCalled();
    expect(state.circuitState.size).toBe(0);
  });

  it('stamps the rebuild floor even when the rebuild wrote nothing', async () => {
    const state = createRealtimeDeviceReconcileState();
    queueEvent(state, { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });

    await flushRealtimeDeviceReconcileQueue({
      state,
      queueKey: QUEUE_KEY,
      requestRebuild: vi.fn().mockResolvedValue(false),
    });

    // The floor is about how often a rebuild STARTS. A no-op rebuild still cost
    // the work, so it must not earn an immediate second one.
    expect(state.lastRebuildAtMsByQueue.get(QUEUE_KEY)).toEqual(expect.any(Number));
  });

  it('opens the breaker after repeated rebuilds that keep writing to the same device', async () => {
    const state = createRealtimeDeviceReconcileState();
    const structuredLog = createInfoLoggerMock();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      queueEvent(state, { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });
      await flushRealtimeDeviceReconcileQueue({
        state,
        queueKey: QUEUE_KEY,
        requestRebuild: vi.fn().mockResolvedValue(true),
        structuredLog,
      });
    }

    expect(structuredLog.info).toHaveBeenCalledWith({
      event: 'realtime_reconcile_circuit_opened',
      suppressMs: 60_000,
      deviceId: 'dev-1',
      deviceName: 'Heater 1',
      capabilityId: 'onoff',
      planExpectation: undefined,
      changes: undefined,
    });
  });

  it('opens the breaker after repeated rebuilds that keep rewriting the same target', async () => {
    const state = createRealtimeDeviceReconcileState();
    const structuredLog = createInfoLoggerMock();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      queueEvent(state, {
        deviceId: 'dev-1',
        name: 'Heater 1',
        capabilityId: 'target_temperature',
        changes: [{ capabilityId: 'target_temperature', previousValue: '25.5°C', nextValue: '26°C' }],
        planExpectation: 'plan target: 20°C',
      });
      await flushRealtimeDeviceReconcileQueue({
        state,
        queueKey: QUEUE_KEY,
        requestRebuild: vi.fn().mockResolvedValue(true),
        structuredLog,
      });
    }

    expect(structuredLog.info).toHaveBeenCalledWith({
      event: 'realtime_reconcile_circuit_opened',
      suppressMs: 60_000,
      deviceId: 'dev-1',
      deviceName: 'Heater 1',
      capabilityId: 'target_temperature',
      planExpectation: 'plan target: 20°C',
      changes: [{ capabilityId: 'target_temperature', previousValue: '25.5°C', nextValue: '26°C' }],
    });
  });
});
