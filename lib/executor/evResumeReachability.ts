import { getLogger } from '../logging/logger';
import type {
  BinaryCommandLifecycleEvent,
  BinaryCommandLifecycleListener,
} from '../observer/pendingBinaryCommands';
import { EV_START_COMMAND_PENDING_MS } from '../observer/pendingBinaryCommandTypes';

const logger = getLogger('executor/ev-resume-reachability');
const RETRY_DELAYS_MS = [15, 30, 60].map((minutes) => minutes * 60 * 1000);

/**
 * What kind of failure armed `retryAtMs`, because the two are scoped
 * differently:
 *
 * - `probe` — the write was ACCEPTED and no charging evidence followed. That is
 *   a statement about the plug-state's ambiguity, so it only gates a device
 *   still sitting in the probed state (`eligibleForStartProbe`).
 * - `transport` — the write was REJECTED outright. That is a statement about
 *   reaching the device at all, which no plug-state makes untrue, so it gates
 *   regardless. Without this split a rejected write on a non-probed charger
 *   would skip the ladder entirely: the dispatcher clears the pending command
 *   and `recordFailure` requests a rebuild, and that rebuild would re-dispatch
 *   the same failing write on the next cycle, forever.
 */
type ReachabilityGate = 'probe' | 'transport';

type ReachabilityState = {
  failures: number;
  retryAtMs?: number;
  gate?: ReachabilityGate;
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
      gate: params.previous?.gate,
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
    ...current, failures: 0, retryAtMs: undefined, gate: undefined, scheduledKind: undefined,
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
      gate: reason === 'dispatch_failed' ? 'transport' : 'probe',
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
          // Carried, not dropped: `retryAtMs` survives an accepted dispatch, so
          // the gate that armed it has to survive alongside or a transport
          // window would silently weaken to a probe one.
          gate: current?.gate,
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
      if (!availableNow || !base) return base;
      // A live retry window gates a device still in the probed state, and gates
      // ANY device whose last write was REJECTED — see ReachabilityGate. Without
      // the second arm a rejected write on a non-probed charger skips the ladder
      // entirely, because the dispatcher clears the pending command and
      // `recordFailure` asks for a rebuild that would re-issue the same write.
      const gated = next.retryAtMs !== undefined && Date.now() < next.retryAtMs;
      if (gated && (eligible || next.gate === 'transport')) return false;
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
