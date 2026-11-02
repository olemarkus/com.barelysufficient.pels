/**
 * Deferred-objective (smart-task) decoration helpers sliced out of
 * `planBuilder.ts`. The identity bundle is the no-smart-task fallback; the
 * release-intent attach resolves requested releases into the posture this plan
 * commands. Execution consumes that decision without reading policy.
 */
import type { DevicePlanDevice, PlanInputDevice, ShedBehavior } from './planTypes';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import type { ShedReleasePosture } from '../planContract/releaseIntent';
import { getDebugEmitter } from '../logging/logger';
import type {
  DeferredDecorationBundle,
  DeferredDecorationInput,
  DeferredReleaseIntent,
} from '../../packages/planner-types/src/deferredDecoration';

// No-smart-task fallback: pass the device list through untouched. Used when no
// decoration controller is wired (e.g. unit tests), keeping the planner free of
// any lib/objectives dependency.
export function buildIdentityDecorationBundle(devices: PlanInputDevice[]): DeferredDecorationBundle {
  return {
    admittedDevices: devices,
    forceShedSet: new Set<string>(),
    deferredHoldCauseByDeviceId: new Map(),
    deferredReleaseIntentByDeviceId: {},
    admittedDeviceIds: new Set<string>(),
    drivingDeviceIds: new Set<string>(),
    lentAuthorityDeviceIds: new Set<string>(),
    externalOffHoldLiftedDeviceIds: new Set<string>(),
  };
}

/**
 * The decoration seam a home with no smart tasks binds: the identity bundle,
 * in the seam's own shape. A meter area is capacity-only by scope (multi-home
 * v1 defers smart tasks per home), so it names this rather than leaving the
 * member off its `HomeScope` — "no smart tasks here" is a thing a home says,
 * not a hole in its wiring that the builder happens to paper over.
 */
export function decorateWithoutDeferredObjectives(input: DeferredDecorationInput): DeferredDecorationBundle {
  return buildIdentityDecorationBundle(input.devices);
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
  getShedBehavior: (deviceId: string) => ShedBehavior,
): DevicePlanDevice[] {
  if (Object.keys(intentByDeviceId).length === 0) return planDevices;
  return planDevices.map((device) => {
    const deferredReleaseIntent = intentByDeviceId[device.id];
    if (!deferredReleaseIntent) return device;
    if (deferredReleaseIntent === 'binary_restore' && !binaryRestoreAllowed) return device;
    if (deferredReleaseIntent !== 'shed_release') {
      return { ...device, deferredReleaseIntent: { kind: deferredReleaseIntent } };
    }
    const posture = resolveShedReleasePosture(device, getShedBehavior(device.id));
    return posture ? { ...device, deferredReleaseIntent: { kind: 'shed_release', posture } } : device;
  });
}

const emitPlanDebug = getDebugEmitter('plan', 'plan');

/** The idle-task lane honors its configured policy even after task authority ends. */
function resolveShedReleasePosture(device: DevicePlanDevice, behavior: ShedBehavior): ShedReleasePosture | undefined {
  if (behavior.action === 'set_temperature') return { kind: 'target_value', target: behavior.temperature };
  if (behavior.action === 'turn_off' || isBinaryPlanDevice(device)) return { kind: 'binary_off' };
  if (isSteppedLoadDevice(device) && device.releaseShedStepId
    && getSteppedLoadStep(device.steppedLoadProfile, device.releaseShedStepId)) {
    return { kind: 'step', stepId: device.releaseShedStepId };
  }
  emitPlanDebug({
    event: 'shed_release_skipped',
    reasonCode: 'no_producer_step_target',
    deviceId: device.id,
    deviceName: device.name,
    releaseShedStepId: device.releaseShedStepId ?? null,
  });
  return undefined;
}
