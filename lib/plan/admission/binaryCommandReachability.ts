import type {
  BinaryCommandLifecycleEvent,
  BinaryCommandLifecycleListener,
} from '../../observer/pendingBinaryCommands';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../observer/controlCommandConfirmation';
import { getLogger } from '../../logging/logger';

const logger = getLogger('plan/binary-command-reachability');

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

  /**
   * The failure bookkeeping both lanes share: count it, arm the backoff, and
   * schedule the retry rebuild. Deliberately does NOT request an immediate
   * rebuild — that is the caller's decision, because the two lifecycle events
   * that land here arrive on different lanes and only one of them may ask.
   * Returns whether the failure was recorded, so a caller that may ask does not
   * have to re-derive the `disposed` / turn-OFF guards.
   */
  const recordFailure = (
    event: BinaryCommandLifecycleEvent,
    lane: 'dispatch' | 'sweep',
  ): boolean => {
    if (disposed || !event.desired) return false;
    const current = stateByDevice.get(event.deviceId);
    const failures = Math.min((current?.failures ?? 0) + 1, RETRY_DELAYS_MS.length);
    const retryDelayMs = RETRY_DELAYS_MS[failures - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 0;
    const retryAtMs = Date.now() + retryDelayMs;
    stateByDevice.set(event.deviceId, { failures, retryAtMs, scheduledKind: 'retry' });
    params.scheduleRebuild(event.deviceId, retryAtMs);
    // The arming is the fact worth logging, and it is logged HERE rather than at
    // either call site so both lanes report it identically. The sweep lane asks
    // for no rebuild, so without this it would arm a 15/30/60-minute backoff with
    // no production signal at all: `pending_binary_command_timed_out` is a
    // `logger.debug` and the pino root sits at `info`, and `binary_command_retry`
    // is a commandability reason that never reaches a log line. Reading an absent
    // `binary_command_reachability_changed` as "the backoff never armed" was only
    // ever sound while the sweep lane also requested a rebuild
    // (`notes/ev-ready-by/README.md`).
    logger.info({
      event: 'binary_command_reachability_backoff_armed',
      component: 'plan',
      deviceId: event.deviceId,
      lane,
      failures,
      retryAtMs,
      retryDelayMs,
    });
    return true;
  };

  return {
    lifecycle: {
      onDispatchAccepted: (event) => {
        if (disposed || !event.desired) return;
        const dueAtMs = event.startedAtMs + CONTROL_COMMAND_CONFIRMATION_MS;
        const current = stateByDevice.get(event.deviceId);
        stateByDevice.set(event.deviceId, {
          failures: current?.failures ?? 0,
          retryAtMs: current?.retryAtMs,
          scheduledKind: 'confirmation',
        });
        params.scheduleRebuild(event.deviceId, dueAtMs);
      },
      // The DISPATCH lane. A definite answer from the transport — a rejection,
      // a 4xx/5xx, an actuator that declined — delivered on the same call stack
      // as the write PELS itself issued. Asking for a rebuild here reports a
      // command outcome, not a device observation, so it stays.
      onDispatchFailed: (event) => {
        if (recordFailure(event, 'dispatch')) params.requestRebuild();
      },
      // The SWEEP lane, and the reason the two are no longer the same function.
      // `onTimedOut` fires from `reconcilePendingEntry`, which runs on whichever
      // lane happened to call the sweep — including the OBSERVATION lane, where
      // `setup/appInit/planObservedStateSubscription.ts` turns every
      // `observedStateChanged` event into `syncLivePlanState`. Requesting a
      // rebuild from here therefore let a device observation drive the planner,
      // which it may not do: an observation may update the UI and drive the
      // executor, but the capacity decision belongs to the whole-home reading,
      // and a rebuild driven by a device event runs against a reading taken
      // before the change (root `AGENTS.md` § Control Flow).
      //
      // No escalation is lost by staying quiet, and the reason is ORDERING, not
      // cadence. `recordFailure` above writes `stateByDevice` synchronously, and
      // `buildPlanForRebuild` runs the sweep BEFORE it reads the devices
      // (`lib/plan/planServiceRebuild.ts` — sweep, then `getPlanDevices()`, whose
      // `project` call reads that state). So whichever rebuild comes next raises
      // this timeout and projects the device uncommandable in the SAME pass that
      // would otherwise have acted on it. There is no pass in which the planner
      // selects this device believing it still commandable.
      //
      // That ordering is the whole argument, and it is sufficient. Deliberately
      // do NOT prop it up with a claim about how soon the next rebuild arrives —
      // two such claims look true and are not. `POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS`
      // (30 s) is evaluated per ARRIVING sample, so it bounds nothing on
      // `power_source = flow`, where cadence is the owner's Flow cadence and
      // `installPowerSampleFreshnessEscalation` is explicitly not a heartbeat. And
      // on `homey_energy` the tight-noop backoff returns `false` ABOVE the
      // max-interval escape (`lib/plan/rebuildScheduler/policy.ts`), holding
      // rebuilds up to `TIGHT_NOOP_BACKOFF_MAX_MS` (120 s) in exactly the
      // tight-headroom state a failed resume creates — and the usual escape,
      // `invalidateRebuildSuppressionForObservation`, cannot fire, because a
      // device that stopped answering emits no observation.
      //
      // Nor does the confirmation deadline cover it. The timer `onDispatchAccepted`
      // arms for `startedAtMs + CONTROL_COMMAND_CONFIRMATION_MS` usually fires at
      // this instant, but is not guaranteed to be there: a Flow-backed binary write
      // awaits an SDK trigger with no timeout, so its entry can reach expiry still
      // `dispatching` and never accepted; `project` below calls `clear` —
      // cancelling that timer — for any device that flaps unavailable and back
      // inside the window; and the `scheduleRebuild` above REPLACES it, because
      // both share the timer key `binaryCommandReachability:<homeId>:<deviceId>`
      // and the registry clears the old handle on register (that last one is
      // tracked in `TODO.md`).
      //
      // What IS deferred is cosmetic: the committed plan snapshot and the settings
      // UI keep showing the device commandable until the next rebuild. The retry
      // rebuild armed above is the long backstop, and it un-blocks rather than
      // blocks — `project` compares `Date.now()` against `retryAtMs` at read time.
      onTimedOut: (event) => {
        recordFailure(event, 'sweep');
      },
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
