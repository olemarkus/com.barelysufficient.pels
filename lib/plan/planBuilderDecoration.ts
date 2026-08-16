/**
 * Deferred-objective (smart-task) decoration helpers sliced out of
 * `planBuilder.ts`. The identity bundle is the no-smart-task fallback; the
 * release-intent attach copies the decoration seam's intents onto plan devices.
 * Behaviour is unchanged — these moved verbatim from the builder.
 */
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import type { PlanContext } from './planContext';
import type {
  DeferredDecorationBundle,
  DeferredReleaseIntent,
} from '../../packages/planner-types/src/deferredDecoration';

// No-smart-task fallback: pass the device list through untouched. Used when no
// decoration controller is wired (e.g. unit tests), keeping the planner free of
// any lib/objectives dependency.
export function buildIdentityDecorationBundle(devices: PlanInputDevice[]): DeferredDecorationBundle {
  return {
    admittedDevices: devices,
    forceShedSet: new Set<string>(),
    deferredAvoidDeviceIds: new Set<string>(),
    deferredReleaseIntentByDeviceId: {},
    admittedDeviceIds: new Set<string>(),
  };
}

export function attachDeferredReleaseIntents(
  planDevices: DevicePlanDevice[],
  intentByDeviceId: Record<string, DeferredReleaseIntent>,
  context: PlanContext,
): DevicePlanDevice[] {
  if (Object.keys(intentByDeviceId).length === 0) return planDevices;
  return planDevices.map((device) => {
    const deferredReleaseIntent = intentByDeviceId[device.id];
    if (!deferredReleaseIntent) return device;
    // binary_restore is the only intent that drives a positive (turn-on) command, so it requires
    // a MEASURED sample to avoid racing the capacity guard on a synthesized headroom.
    // binary_release and shed_release are negative commands and remain safe without one.
    if (deferredReleaseIntent === 'binary_restore' && !context.powerIsMeasured) return device;
    return { ...device, deferredReleaseIntent };
  });
}
