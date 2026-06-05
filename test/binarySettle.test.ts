import {
  LOCAL_BINARY_SETTLE_WINDOW_MS,
  clearAllPendingBinarySettleWindows,
  createBinarySettleState,
  notePendingBinarySettleObservation,
  startPendingBinarySettleWindow,
} from '../lib/observer/binarySettle';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

function buildSettleSnapshot(overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot {
  return {
    id: 'dev-1',
    name: 'Test Device',
    controlCapabilityId: 'onoff',
    canSetControl: true,
    binaryControl: { on: false },
    ...overrides,
  } as TargetDeviceSnapshot;
}

describe('observer binarySettle device identity hygiene', () => {
  it('does not emit a duplicate lifecycle log when a binary settle window starts', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          getSnapshotById: () => undefined,
          emitPlanReconcile: vi.fn(),
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: true,
      });

      expect(info).not.toHaveBeenCalled();
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('keeps reconcile identity on deviceId without rewriting a missing name to the id', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const emitPlanReconcile = vi.fn();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          getSnapshotById: () => undefined,
          emitPlanReconcile,
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: true,
      });
      info.mockClear();

      const outcome = notePendingBinarySettleObservation({
        state,
        deps: {
          logger: { structuredLog: { info } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          getSnapshotById: () => undefined,
          emitPlanReconcile,
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: false,
        source: 'realtime_capability',
      });

      expect(outcome).toBe('drift');
      expect(info).toHaveBeenCalledWith({
        event: 'binary_write_observed',
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        desired: true,
        observed: false,
        source: 'realtime_capability',
        outcome: 'drift',
      });
      expect(emitPlanReconcile).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        name: undefined,
        capabilityId: 'onoff',
        changes: [{
          capabilityId: 'onoff',
          previousValue: 'on',
          nextValue: 'off',
        }],
      });
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });
});

describe('observer binarySettle timeout finalization', () => {
  // The 5-second settle window is a reconciliation boundary: if no confirming
  // observation arrives, the window must close, the local-write suppression
  // entry must be cleared (so subsequent realtime events stop being treated as
  // our own echoes), and reconcile fires ONLY when the snapshot proves a drift.
  // Tests pin each branch so a future refactor of `finalizePendingBinarySettleWindow`
  // can't silently change a side-effect.

  it('clears local capability write suppression on timeout regardless of snapshot freshness', () => {
    vi.useFakeTimers();
    const clearLocalCapabilityWrite = vi.fn();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info: vi.fn() } },
          clearLocalCapabilityWrite,
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          // Simulate the abandon-grace case: the snapshot store has nothing
          // for this device (Homey SDK miss; persisted state must NOT be
          // wiped). See `feedback_homey_sdk_unreliable`.
          getSnapshotById: () => undefined,
          emitPlanReconcile: vi.fn(),
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: true,
      });

      vi.advanceTimersByTime(LOCAL_BINARY_SETTLE_WINDOW_MS);

      // Suppression cleared even when snapshot is missing — the local-write
      // record must not outlive the settle window.
      expect(clearLocalCapabilityWrite).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        capabilityId: 'onoff',
      });
      expect(state.pendingBinarySettleWindows.size).toBe(0);
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('skips reconcile + timeout log on timeout when the snapshot is missing (abandon-grace)', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const emitPlanReconcile = vi.fn();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          getSnapshotById: () => undefined,
          emitPlanReconcile,
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: true,
      });

      vi.advanceTimersByTime(LOCAL_BINARY_SETTLE_WINDOW_MS);

      // No snapshot means we can't confidently report drift; staying quiet is
      // the right call so a single transient SDK miss doesn't trigger spurious
      // reconciles.
      expect(emitPlanReconcile).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('emits binary_write_timeout + reconcile when snapshot diverges from desired', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const emitPlanReconcile = vi.fn();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          getSnapshotById: () => buildSettleSnapshot({ binaryControl: { on: false }, name: 'EV Charger' }),
          emitPlanReconcile,
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: true,
        deviceName: 'EV Charger',
      });

      vi.advanceTimersByTime(LOCAL_BINARY_SETTLE_WINDOW_MS);

      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'binary_write_timeout',
        deviceId: 'dev-1',
        deviceName: 'EV Charger',
        capabilityId: 'onoff',
        desired: true,
      }));
      expect(emitPlanReconcile).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        name: 'EV Charger',
        capabilityId: 'onoff',
        changes: [{
          capabilityId: 'onoff',
          previousValue: 'on',
          nextValue: 'off',
        }],
      });
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('emits timeout log but no reconcile when snapshot matches desired (delayed settle)', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const emitPlanReconcile = vi.fn();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          // Snapshot already reflects the desired state — the realtime echo
          // arrived after the settle window expired, but the device did the
          // right thing. No drift to reconcile, but the timeout log fires for
          // operator visibility.
          getSnapshotById: () => buildSettleSnapshot({ binaryControl: { on: true } }),
          emitPlanReconcile,
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: true,
      });

      vi.advanceTimersByTime(LOCAL_BINARY_SETTLE_WINDOW_MS);

      expect(info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'binary_write_timeout',
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        desired: true,
      }));
      expect(emitPlanReconcile).not.toHaveBeenCalled();
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('skips log + reconcile on timeout when device is no longer tracked', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const emitPlanReconcile = vi.fn();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          // Device dropped out of the managed set between window-open and
          // timeout. Don't emit timeout diagnostics for devices PELS no
          // longer manages.
          shouldTrackRealtimeDevice: () => false,
          getSnapshotById: () => buildSettleSnapshot({ binaryControl: { on: false } }),
          emitPlanReconcile,
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: true,
      });

      vi.advanceTimersByTime(LOCAL_BINARY_SETTLE_WINDOW_MS);

      expect(info).not.toHaveBeenCalled();
      expect(emitPlanReconcile).not.toHaveBeenCalled();
      expect(state.pendingBinarySettleWindows.size).toBe(0);
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('does not open a window when value is not boolean (e.g., target capability)', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          getSnapshotById: () => buildSettleSnapshot(),
          emitPlanReconcile: vi.fn(),
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: 'invalid' as unknown as boolean,
      });

      // Non-boolean values reach this function from target/setNumber paths
      // that share the same wiring; settle is binary-only and must skip them.
      expect(state.pendingBinarySettleWindows.size).toBe(0);
      vi.advanceTimersByTime(LOCAL_BINARY_SETTLE_WINDOW_MS);
      expect(info).not.toHaveBeenCalled();
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('does not open a window for capabilities outside the binary-settle allowlist', () => {
    vi.useFakeTimers();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info: vi.fn() } },
          clearLocalCapabilityWrite: vi.fn(),
          isLiveFeedHealthy: () => true,
          shouldTrackRealtimeDevice: () => true,
          getSnapshotById: () => buildSettleSnapshot(),
          emitPlanReconcile: vi.fn(),
        },
        deviceId: 'dev-1',
        // measure_power is not in BINARY_SETTLE_CAPABILITY_IDS; settle must
        // ignore it (otherwise every power update would open a phantom window).
        capabilityId: 'measure_power',
        value: true,
      });

      expect(state.pendingBinarySettleWindows.size).toBe(0);
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('does not open a window when the live feed is unhealthy', () => {
    vi.useFakeTimers();
    const state = createBinarySettleState();

    try {
      startPendingBinarySettleWindow({
        state,
        deps: {
          logger: { structuredLog: { info: vi.fn() } },
          clearLocalCapabilityWrite: vi.fn(),
          // Live feed unhealthy means realtime echo can't be trusted to
          // settle the window; better to skip opening it than to time out
          // and produce spurious drift after a 5 s delay.
          isLiveFeedHealthy: () => false,
          shouldTrackRealtimeDevice: () => true,
          getSnapshotById: () => buildSettleSnapshot(),
          emitPlanReconcile: vi.fn(),
        },
        deviceId: 'dev-1',
        capabilityId: 'onoff',
        value: true,
      });

      expect(state.pendingBinarySettleWindows.size).toBe(0);
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });

  it('returns none when an observation arrives with no matching pending window', () => {
    const emitPlanReconcile = vi.fn();
    const state = createBinarySettleState();

    const outcome = notePendingBinarySettleObservation({
      state,
      deps: {
        logger: { structuredLog: { info: vi.fn() } },
        clearLocalCapabilityWrite: vi.fn(),
        isLiveFeedHealthy: () => true,
        shouldTrackRealtimeDevice: () => true,
        getSnapshotById: () => undefined,
        emitPlanReconcile,
      },
      deviceId: 'dev-1',
      capabilityId: 'onoff',
      value: true,
      source: 'realtime_capability',
    });

    expect(outcome).toBe('none');
    expect(emitPlanReconcile).not.toHaveBeenCalled();
  });

  it('cancels the pending timer when an observation arrives within the window', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const emitPlanReconcile = vi.fn();
    const state = createBinarySettleState();

    try {
      const deps = {
        logger: { structuredLog: { info } },
        clearLocalCapabilityWrite: vi.fn(),
        isLiveFeedHealthy: () => true,
        shouldTrackRealtimeDevice: () => true,
        getSnapshotById: () => buildSettleSnapshot(),
        emitPlanReconcile,
      };

      startPendingBinarySettleWindow({
        state, deps, deviceId: 'dev-1', capabilityId: 'onoff', value: true,
      });

      vi.advanceTimersByTime(1_000);
      const outcome = notePendingBinarySettleObservation({
        state, deps,
        deviceId: 'dev-1', capabilityId: 'onoff',
        value: true, source: 'realtime_capability',
      });

      expect(outcome).toBe('settled');
      expect(state.pendingBinarySettleWindows.size).toBe(0);

      // Advancing past the original deadline must not fire the (now-cancelled)
      // timeout — otherwise the second clear would surface a `binary_write_timeout`
      // log after the window already settled.
      info.mockClear();
      vi.advanceTimersByTime(LOCAL_BINARY_SETTLE_WINDOW_MS);
      expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'binary_write_timeout' }));
    } finally {
      clearAllPendingBinarySettleWindows(state);
      vi.useRealTimers();
    }
  });
});
