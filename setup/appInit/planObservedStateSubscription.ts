import type {
  ObservedStateChangedEvent,
  ObservedStateEmitter,
  ObservedControlStateChangedEvent,
} from '../../lib/observer/observedStateEvents';
import { incPerfCounter } from '../../lib/utils/perfCounters';
import type { AppContext } from '../../lib/app/appContext';
import { requirePlanService } from './contextGuards';

/**
 * The slice of the transport wiring the PLAN-side subscription needs. Narrower
 * than `DeviceTransportWiringDeps` on purpose: this subscription is registered
 * by its own startup step, after the plan service exists, and must not grow a
 * reason to run any earlier.
 */
export type PlanObservedStateSubscriptionDeps = {
  ctx: AppContext;
  getObservedStateEmitter: () => ObservedStateEmitter;
  /**
   * Update "leave it off until turned on again" for a device whose observed
   * control state moved, routed to its owning home. No rebuild: the hold is
   * state the next build reads off the live device.
   */
  syncExternalOffHold: (event: ObservedControlStateChangedEvent) => void;
  /**
   * Clear the rebuild suppressions of the home that OWNS this device. Routed for
   * the same reason the hold above it is: each bundle keeps a separate
   * `PowerSampleRebuildState`, so clearing main's for a sub-home device clears
   * the wrong house and leaves the right one throttled.
   */
  invalidateRebuildSuppression: (deviceId: string) => void;
};

/**
 * The plan-dependent half of the observed-state fan-out, registered by its own
 * startup step AFTER `initPlanService`.
 *
 * It lives in a separate step because every listener here reaches the plan
 * service: `syncLivePlanState` calls it directly, and the external-off hold
 * reads the owning home's pending-command store through it. Registering these
 * with the transport meant they were live from `initDeviceManager` — three
 * awaited startup steps before the service existed — so a device event landing
 * in that gap had its work silently dropped. Ordering removes the window
 * instead of guarding it: keep this step after `initPlanService`.
 *
 * **No listener here requests a plan rebuild.** An observed device change is
 * planner input, not a capacity trigger — the decision is about the whole-home
 * reading, and a rebuild driven by a device event runs against a reading taken
 * before the change (root `AGENTS.md` § Control Flow). What an observation may
 * do is stop the reading already on its way from being throttled away, which is
 * `invalidateRebuildSuppressionForObservation`.
 */
export function subscribePlanObservedState(deps: PlanObservedStateSubscriptionDeps): void {
  const { ctx } = deps;
  const emitter = deps.getObservedStateEmitter();
  emitter.onObservedControlStateChanged((event: ObservedControlStateChangedEvent) => {
    deps.syncExternalOffHold(event);
    if (!ctx.isCapacityControlEnabled(event.deviceId)) return;
    incPerfCounter('plan_rebuild_suppression_invalidate_requested.control_state_total');
    deps.invalidateRebuildSuppression(event.deviceId);
  });
  emitter.onObservedStateChanged((event: ObservedStateChangedEvent) => {
    if (
      event.measurePowerBecameSignificantlyPositive === true
      && ctx.isCapacityControlEnabled(event.deviceId)
    ) {
      incPerfCounter('plan_rebuild_suppression_invalidate_requested.measure_power_total');
      deps.invalidateRebuildSuppression(event.deviceId);
    }
    void requirePlanService(ctx).syncLivePlanState(event.source);
  });
}
