/**
 * Deferred-objective (smart-task) decoration helpers sliced out of
 * `planBuilder.ts`. The identity bundle is the no-smart-task fallback; the
 * release-intent attach copies the decoration seam's intents onto plan devices.
 * Behaviour is unchanged — these moved verbatim from the builder.
 */
import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
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

/**
 * `binaryRestoreAllowed` is the seam between the two passes: `binary_restore`
 * is the only intent that drives a positive (turn-on) command, so it rides only
 * a MEASURED cycle's plan — the silent-meter pass passes `false`, and the
 * executor's own gate (`executablePlanProjection.ts`) reads the meta's signal
 * for the same reason. `binary_release` and `shed_release` are negative
 * commands and ride either plan.
 */
export function attachDeferredReleaseIntents(
  planDevices: DevicePlanDevice[],
  intentByDeviceId: Record<string, DeferredReleaseIntent>,
  binaryRestoreAllowed: boolean,
): DevicePlanDevice[] {
  if (Object.keys(intentByDeviceId).length === 0) return planDevices;
  return planDevices.map((device) => {
    const deferredReleaseIntent = intentByDeviceId[device.id];
    if (!deferredReleaseIntent) return device;
    if (deferredReleaseIntent === 'binary_restore' && !binaryRestoreAllowed) return device;
    return { ...device, deferredReleaseIntent };
  });
}
