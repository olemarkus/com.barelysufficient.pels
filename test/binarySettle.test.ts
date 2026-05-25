import {
  clearAllPendingBinarySettleWindows,
  createBinarySettleState,
  notePendingBinarySettleObservation,
  startPendingBinarySettleWindow,
} from '../lib/observer/binarySettle';

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
