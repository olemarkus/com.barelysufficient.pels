import { getLogger } from '../logging/logger';
import type {
  BinaryCommandLifecycleEvent,
  BinaryCommandLifecycleListener,
} from '../observer/pendingBinaryCommands';
import { EV_START_COMMAND_PENDING_MS } from '../observer/pendingBinaryCommandTypes';

const logger = getLogger('executor/ev-resume-reachability');
const RETRY_DELAYS_MS = [15, 30, 60].map((minutes) => minutes * 60 * 1000);

type ReachabilityState = {
  failures: number;
  retryAtMs?: number;
  eligible: boolean;
  available: boolean;
  scheduledKind?: 'settlement' | 'retry';
};

/**
 * The commandability answer as it passes through the probe: a plain boolean. The
 * probe's own veto ("commanded, never started charging") needs no reason string
 * riding with it — the surface that renders the answer derives the wording from
 * the same observed facts (`resolveCommandabilityDetail`).
 */
export type CommandabilityProjection = boolean;

export type EvResumeReachability = {
  lifecycle: BinaryCommandLifecycleListener;
  project: (params: {
    deviceId: string;
    eligibleForStartProbe: boolean;
    activityObserved: boolean;
    available?: boolean;
    base: CommandabilityProjection;
  }) => CommandabilityProjection;
  prune: (presentDeviceIds: ReadonlySet<string>) => void;
  dispose: () => void;
};

const isResumeEvent = (event: BinaryCommandLifecycleEvent): boolean => (
  event.capabilityId === 'evcharger_charging' && event.desired
);

const hasRecovered = (params: {
  previous: ReachabilityState | undefined;
  eligible: boolean;
  available: boolean;
  activityObserved: boolean;
}): boolean => params.previous !== undefined && (
  (!params.previous.eligible && params.eligible)
  || (!params.previous.available && params.available)
  || params.activityObserved
);

function resolveNextReachabilityState(params: {
  previous: ReachabilityState | undefined;
  eligible: boolean;
  available: boolean;
  activityObserved: boolean;
}): { recovered: boolean; next: ReachabilityState } {
  const recovered = hasRecovered(params);
  if (recovered) {
    return {
      recovered,
      next: {
        failures: 0,
        eligible: params.eligible,
        available: params.available,
        scheduledKind: params.previous?.scheduledKind === 'settlement' ? 'settlement' : undefined,
      },
    };
  }
  return {
    recovered,
    next: {
      failures: params.previous?.failures ?? 0,
      retryAtMs: params.previous?.retryAtMs,
      eligible: params.eligible,
      available: params.available,
      scheduledKind: params.previous?.scheduledKind,
    },
  };
}

function createScheduledRebuildOwner(params: {
  schedule: (deviceId: string, dueAtMs: number) => void;
  clear: (deviceId: string) => void;
  isDisposed: () => boolean;
}) {
  const devices = new Set<string>();
  return {
    schedule: (deviceId: string, dueAtMs: number) => {
      if (params.isDisposed()) return;
      devices.add(deviceId);
      params.schedule(deviceId, dueAtMs);
    },
    clear: (deviceId: string) => {
      devices.delete(deviceId);
      params.clear(deviceId);
    },
    dispose: () => {
      for (const deviceId of devices) params.clear(deviceId);
      devices.clear();
    },
  };
}

function clearReachabilityFailure(
  stateByDevice: Map<string, ReachabilityState>,
  clearScheduled: (deviceId: string) => void,
  deviceId: string,
): void {
  const current = stateByDevice.get(deviceId);
  clearScheduled(deviceId);
  if (!current || current.failures === 0) return;
  stateByDevice.set(deviceId, {
    ...current, failures: 0, retryAtMs: undefined, scheduledKind: undefined,
  });
}

export function createEvResumeReachability(params: {
  requestRebuild: () => void;
  scheduleRebuild: (deviceId: string, dueAtMs: number) => void;
  clearScheduledRebuild: (deviceId: string) => void;
}): EvResumeReachability {
  const stateByDevice = new Map<string, ReachabilityState>();
  let disposed = false;
  const scheduled = createScheduledRebuildOwner({
    schedule: params.scheduleRebuild,
    clear: params.clearScheduledRebuild,
    isDisposed: () => disposed,
  });
  const recordFailure = (event: BinaryCommandLifecycleEvent, reason: 'dispatch_failed' | 'timed_out'): void => {
    if (disposed) return;
    if (!isResumeEvent(event)) return;
    const current = stateByDevice.get(event.deviceId);
    const failures = Math.min((current?.failures ?? 0) + 1, RETRY_DELAYS_MS.length);
    const retryDelayMs = RETRY_DELAYS_MS[failures - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 0;
    const retryAtMs = Date.now() + retryDelayMs;
    stateByDevice.set(event.deviceId, {
      failures,
      retryAtMs,
      eligible: current?.eligible ?? true,
      available: current?.available ?? true,
      scheduledKind: 'retry',
    });
    logger.info({
      event: 'ev_resume_probe_failed',
      deviceId: event.deviceId,
      reasonCode: reason,
      retryAtMs,
      failureCount: failures,
      ...(event.startedAtMs !== undefined && event.settledAtMs !== undefined
        ? { elapsedMs: event.settledAtMs - event.startedAtMs }
        : {}),
    });
    scheduled.schedule(event.deviceId, retryAtMs);
    params.requestRebuild();
  };

  return {
    lifecycle: {
      onDispatchAccepted: (event) => {
        if (disposed) return;
        if (!isResumeEvent(event)) return;
        const current = stateByDevice.get(event.deviceId);
        stateByDevice.set(event.deviceId, {
          failures: current?.failures ?? 0,
          retryAtMs: current?.retryAtMs,
          eligible: current?.eligible ?? true,
          available: current?.available ?? true,
          scheduledKind: 'settlement',
        });
        scheduled.schedule(
          event.deviceId,
          (event.startedAtMs ?? Date.now()) + EV_START_COMMAND_PENDING_MS,
        );
        logger.info({
          event: 'ev_resume_probe_started',
          deviceId: event.deviceId,
          startedAtMs: event.startedAtMs,
        });
      },
      onDispatchFailed: (event) => recordFailure(event, 'dispatch_failed'),
      onTimedOut: (event) => recordFailure(event, 'timed_out'),
      onConfirmed: (event) => {
        if (disposed) return;
        if (!isResumeEvent(event)) return;
        clearReachabilityFailure(stateByDevice, scheduled.clear, event.deviceId);
        logger.info({
          event: 'ev_resume_probe_succeeded',
          deviceId: event.deviceId,
          evidenceSource: event.evidenceSource,
          ...(event.startedAtMs !== undefined && event.settledAtMs !== undefined
            ? { elapsedMs: event.settledAtMs - event.startedAtMs }
            : {}),
        });
      },
    },
    project: ({ deviceId, eligibleForStartProbe, activityObserved, available, base }) => {
      if (disposed) return base;
      const eligible = eligibleForStartProbe;
      const availableNow = available !== false;
      const previous = stateByDevice.get(deviceId);
      const { recovered, next } = resolveNextReachabilityState({
        previous, eligible, available: availableNow, activityObserved,
      });
      stateByDevice.set(deviceId, next);
      if (recovered && previous?.scheduledKind === 'retry') {
        scheduled.clear(deviceId);
      }
      if (!eligible || !availableNow || !base) return base;
      if (next.retryAtMs !== undefined && Date.now() < next.retryAtMs) return false;
      return base;
    },
    prune: (presentDeviceIds) => {
      if (disposed) return;
      for (const deviceId of stateByDevice.keys()) {
        if (!presentDeviceIds.has(deviceId)) {
          if (stateByDevice.get(deviceId)?.scheduledKind === 'retry') {
            scheduled.clear(deviceId);
          }
          stateByDevice.delete(deviceId);
        }
      }
    },
    dispose: () => {
      disposed = true;
      scheduled.dispose();
      stateByDevice.clear();
    },
  };
}
