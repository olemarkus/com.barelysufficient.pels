import type {
  ObservedStateChangedEvent,
  ObservedStateEmitter,
  PlanReconcileObservedEvent,
} from '../../lib/observer/observedStateEvents';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import { incPerfCounters } from '../../lib/utils/perfCounters';
import { isStateOfChargeCapabilityId } from '../../lib/device/transport/stateOfCharge';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { AppContext } from '../../lib/app/appContext';
import type { RealtimeDeviceReconcileEvent } from '../appRealtimeDeviceReconcile';
import { requirePlanService } from './contextGuards';

/**
 * The slice of the transport wiring the PLAN-side subscription needs. Narrower
 * than `DeviceTransportWiringDeps` on purpose: this subscription is registered
 * by its own startup step, after the plan service exists, and must not grow a
 * reason to run any earlier.
 */
export type PlanObservedStateSubscriptionDeps = {
  ctx: AppContext;
  planRebuildScheduler: PlanRebuildScheduler;
  getObservedStateEmitter: () => ObservedStateEmitter;
  getSnapshotDevice: (deviceId: string) => TargetDeviceSnapshot | undefined;
  hasEnabledEvBoostForSnapshot: (device: TargetDeviceSnapshot | undefined) => boolean;
  scheduleRealtimeDeviceReconcile: (event: RealtimeDeviceReconcileEvent) => void;
};

function shouldRebuildPlanForRealtimeEvSocObservation(
  deps: PlanObservedStateSubscriptionDeps,
  event: ObservedStateChangedEvent,
): boolean {
  const capabilityIds = [
    ...(event.capabilityId ? [event.capabilityId] : []),
    ...(event.observedCapabilityIds ?? []),
  ];
  if (!capabilityIds.some((capabilityId) => isStateOfChargeCapabilityId(capabilityId))) return false;
  return deps.hasEnabledEvBoostForSnapshot(deps.getSnapshotDevice(event.deviceId));
}

/**
 * The plan-dependent half of the observed-state fan-out, registered by its own
 * startup step AFTER `initPlanService`.
 *
 * It lives in a separate step because every listener here reaches the plan
 * service: the reconcile route rebuilds through it, the EV-SoC intent executes
 * through it (`PlanRebuildIntentPolicy.executeIntent` →
 * `getPlanService().rebuildPlanFromCache`, a NON-optional read), and
 * `syncLivePlanState` calls it directly. Registering these with the transport
 * meant they were live from `initDeviceManager` — three awaited startup steps
 * before the service existed — so a device event landing in that gap either had
 * its work silently dropped or queued a rebuild intent that would dereference
 * `undefined`. Ordering removes the window instead of guarding it: keep this
 * step after `initPlanService`.
 */
export function subscribePlanObservedState(deps: PlanObservedStateSubscriptionDeps): void {
  const { ctx } = deps;
  const emitter = deps.getObservedStateEmitter();
  emitter.onPlanReconcile((event: PlanReconcileObservedEvent) => {
    deps.scheduleRealtimeDeviceReconcile(event);
  });
  emitter.onObservedStateChanged((event: ObservedStateChangedEvent) => {
    if (shouldRebuildPlanForRealtimeEvSocObservation(deps, event)) {
      incPerfCounters([
        'plan_rebuild_requested_total',
        'plan_rebuild_requested.flow_total',
        'plan_rebuild_requested.flow.realtime_ev_soc_total',
      ]);
      deps.planRebuildScheduler.request({
        kind: 'flow',
        reason: 'realtime_ev_soc',
      });
    }
    if (
      event.measurePowerBecameSignificantlyPositive === true
      && ctx.isCapacityControlEnabled(event.deviceId)
    ) {
      // eslint-disable-next-line functional/immutable-data -- shared AppContext write
      ctx.powerSampleRebuildState = {
        ...ctx.powerSampleRebuildState,
        shortfallSuppressionInvalidated: true,
      };
    }
    void requirePlanService(ctx).syncLivePlanState(event.source);
  });
}

