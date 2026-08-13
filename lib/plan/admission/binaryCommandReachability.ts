import type {
  BinaryCommandLifecycleEvent,
  BinaryCommandLifecycleListener,
} from '../../observer/pendingBinaryCommands';

const RETRY_DELAYS_MS = [15, 30, 60].map((minutes) => minutes * 60 * 1000);

type ReachabilityState = {
  failures: number;
  retryAtMs?: number;
  scheduledKind?: 'confirmation' | 'retry';
  sawUnavailable?: boolean;
};

export type BinaryCommandabilityProjection = {
  commandableNow: boolean;
  reason: 'none' | 'binary_command_retry';
};

export type BinaryCommandReachability = {
  lifecycle: BinaryCommandLifecycleListener;
  project: (params: {
    deviceId: string;
    base: boolean;
    observedOn: boolean;
    available: boolean;
  }) => BinaryCommandabilityProjection;
  prune: (presentDeviceIds: ReadonlySet<string>) => void;
  dispose: () => void;
};

export function createBinaryCommandReachability(params: {
  requestRebuild: () => void;
  scheduleRebuild: (deviceId: string, dueAtMs: number) => void;
  clearScheduledRebuild: (deviceId: string) => void;
}): BinaryCommandReachability {
  const stateByDevice = new Map<string, ReachabilityState>();
  let disposed = false;

  const clear = (deviceId: string): void => {
    params.clearScheduledRebuild(deviceId);
    stateByDevice.delete(deviceId);
  };

  const recordFailure = (event: BinaryCommandLifecycleEvent): void => {
    if (disposed || !event.desired) return;
    const current = stateByDevice.get(event.deviceId);
    const failures = Math.min((current?.failures ?? 0) + 1, RETRY_DELAYS_MS.length);
    const retryDelayMs = RETRY_DELAYS_MS[failures - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 0;
    const retryAtMs = Date.now() + retryDelayMs;
    stateByDevice.set(event.deviceId, { failures, retryAtMs, scheduledKind: 'retry' });
    params.scheduleRebuild(event.deviceId, retryAtMs);
    params.requestRebuild();
  };

  return {
    lifecycle: {
      onDispatchAccepted: (event) => {
        if (disposed || !event.desired) return;
        const dueAtMs = event.startedAtMs + event.confirmationMs;
        const current = stateByDevice.get(event.deviceId);
        stateByDevice.set(event.deviceId, {
          failures: current?.failures ?? 0,
          retryAtMs: current?.retryAtMs,
          scheduledKind: 'confirmation',
        });
        params.scheduleRebuild(event.deviceId, dueAtMs);
      },
      onDispatchFailed: recordFailure,
      onTimedOut: recordFailure,
      onConfirmed: (event) => {
        if (!disposed && event.desired) clear(event.deviceId);
      },
    },
    project: ({ deviceId, base, observedOn, available }) => {
      if (disposed) return { commandableNow: base, reason: 'none' };
      const current = stateByDevice.get(deviceId);
      if (!current) return { commandableNow: base, reason: 'none' };
      if (observedOn || (available && current.sawUnavailable)) {
        clear(deviceId);
        return { commandableNow: base, reason: 'none' };
      }
      if (!available && !current.sawUnavailable) {
        stateByDevice.set(deviceId, { ...current, sawUnavailable: true });
      }
      if (!base) return { commandableNow: false, reason: 'none' };
      const retryAtMs = current.retryAtMs;
      if (retryAtMs === undefined || Date.now() >= retryAtMs) {
        return { commandableNow: true, reason: 'none' };
      }
      return { commandableNow: false, reason: 'binary_command_retry' };
    },
    prune: (presentDeviceIds) => {
      if (disposed) return;
      for (const deviceId of stateByDevice.keys()) {
        if (!presentDeviceIds.has(deviceId)) clear(deviceId);
      }
    },
    dispose: () => {
      disposed = true;
      for (const deviceId of stateByDevice.keys()) params.clearScheduledRebuild(deviceId);
      stateByDevice.clear();
    },
  };
}
