import {
  syncExternalOffHoldForDevice,
  toExternalOffHoldObservedDevice,
  type ExternalOffHoldSyncDeps,
} from './externalOffHoldDetection';
import type { AppContext } from '../lib/app/appContext';
import type { ObservedControlStateChangedEvent } from '../lib/observer/observedStateEvents';
import type { HomeId } from '../lib/utils/settingsKeys';
import type { OwningHomeHooks } from './homeRuntime/createHomeCapacityBundle';
import type { StructuredDebugEmitter } from '../lib/logging/logger';
import { invalidateRebuildSuppressionForObservation } from '../lib/plan/rebuildScheduler/observationSuppression';

/**
 * Structural slice of the home-runtime registry this consumes (multi-home R7b
 * P1#1). Kept structural so this module needs no value import of
 * `HomeRuntimeRegistry` — the wiring passes the registry (or `undefined` before
 * `initHomeRuntimeRegistry`, and for the no-sub-homes case).
 */
type OwningHomeRouter = {
  getOwningHomeRouteForDevice: (deviceId: string) => {
    homeId: HomeId;
    hooks: OwningHomeHooks;
  } | undefined;
};

/**
 * What is left of the realtime device lane: an observed control-state change
 * updates the "leave it off until turned on again" hold and clears the owning
 * home's rebuild suppressions, and stops there.
 *
 * It used to queue a plan rebuild as well, behind a 250 ms debounce, a 2 s
 * rebuild floor, and a per-device circuit breaker — all of which existed to make
 * a device event affordable as a trigger for a whole-home capacity decision. It
 * is not one: that decision is about the meter reading, and a rebuild driven by
 * a device event runs against a reading taken before the change. The reading
 * that DOES see it is already on its way, and the plan it builds is a full
 * re-decide (root `AGENTS.md` § Control Flow).
 *
 * The hold itself never needed the rebuild. It is state the PLANNER picks up on
 * its next build (`resolveExternalOffHoldActive` in `setup/appInit/toPlanDevice.ts`)
 * and the executor then respects (`planExecutionDrift.ts`), and the reason the
 * old code rebuilt immediately was to pre-empt the queued reconcile's stale ON
 * command — a command that no longer exists to pre-empt.
 */
export function syncExternalOffHoldForObservation(params: {
  ctx: AppContext;
  event: ObservedControlStateChangedEvent;
  /**
   * Owning-home router (R7b P1#1). Main and each sub-home keep their own plan
   * engine, so asking main's about a sub-home device reports "no pending
   * command" for PELS's own write and fabricates a hold.
   */
  getHomeRuntimeRegistry?: () => OwningHomeRouter | undefined;
}): void {
  const { ctx, event } = params;
  if (!ctx.externalOffHold) return;
  const subHomeHooks = params.getHomeRuntimeRegistry?.()
    ?.getOwningHomeRouteForDevice(event.deviceId)?.hooks;
  const debugStructured = ctx.getStructuredDebugEmitter('reconcile', 'devices');
  syncExternalOffHoldForDevice({
    deps: {
      policy: ctx.externalOffHold,
      ...buildExternalOffHoldHooks(ctx, subHomeHooks, debugStructured),
    },
    deviceId: event.deviceId,
    observedDevice: toExternalOffHoldObservedDevice(
      ctx.latestTargetSnapshot.find((device) => device.id === event.deviceId),
    ),
    changes: event.changes,
  });
}

/** Bind the external-off seams to the device's owning home (main when unrouted). */
function buildExternalOffHoldHooks(
  ctx: AppContext,
  subHomeHooks: Pick<OwningHomeHooks, 'hasPendingBinaryCommand' | 'clearRecentBinaryOffCommand'> | undefined,
  debugStructured: StructuredDebugEmitter | undefined,
): Pick<ExternalOffHoldSyncDeps, 'hasPendingBinaryCommand' | 'clearRecentBinaryOffCommand' | 'debugStructured'> {
  return {
    hasPendingBinaryCommand: subHomeHooks?.hasPendingBinaryCommand
      ?? ((deviceId) => (
        ctx.planEngine?.hasAttributablePendingBinaryCommand(deviceId) === true
      )),
    clearRecentBinaryOffCommand: subHomeHooks?.clearRecentBinaryOffCommand
      ?? ((deviceId) => {
        ctx.planEngine?.clearRecentBinaryOffCommand(deviceId);
      }),
    debugStructured,
  };
}

/**
 * Clear the rebuild suppressions of the home that OWNS this device.
 *
 * Routed for the same reason the hold above is, and with a sharper failure mode:
 * main and each sub-home hold SEPARATE `PowerSampleRebuildState`s, so an
 * unrouted write is silent in both directions — main's suppressions are cleared
 * on a house that saw nothing, and the owning home keeps the
 * "nothing is actionable" verdict the moved device just falsified, worth up to
 * the 120 s tight-noop backoff.
 *
 * The invalidation itself is not a rebuild request: see
 * `lib/plan/rebuildScheduler/observationSuppression.ts` for what it may and may
 * not change.
 */
export function invalidateOwningHomeRebuildSuppression(params: {
  ctx: AppContext;
  deviceId: string;
  getHomeRuntimeRegistry?: () => OwningHomeRouter | undefined;
}): void {
  const { ctx, deviceId } = params;
  const subHomeHooks = params.getHomeRuntimeRegistry?.()
    ?.getOwningHomeRouteForDevice(deviceId)?.hooks;
  if (subHomeHooks) {
    subHomeHooks.invalidateRebuildSuppression();
    return;
  }
  // eslint-disable-next-line functional/immutable-data -- shared AppContext write
  ctx.powerSampleRebuildState = invalidateRebuildSuppressionForObservation(
    ctx.powerSampleRebuildState,
  );
}
