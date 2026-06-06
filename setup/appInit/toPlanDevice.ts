import { isDeviceObservationStale } from '../../lib/observer/observationFreshness';
import {
  resolveCanSetControl,
  resolveCommandableNow,
} from '../../lib/device/deviceActionProjection';
import { buildResidualKwForPlanDevice } from './residualKwForPlanDevice';
import type { DecoratedDeviceSnapshot, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { AppContext } from '../../lib/app/appContext';
import {
  buildStepPowerCalibrationView,
  resolveHasRecentObservedDrawAtSelectedStep,
} from './calibrationViews';

export function toPlanDevice(ctx: AppContext, device: DecoratedDeviceSnapshot) {
  const pendingBinaryCommand = ctx.planEngine?.getPendingBinaryCommandForDevice?.(
    device.id,
    device.communicationModel,
  );
  const calibration = buildStepPowerCalibrationView(ctx, device);
  const hasRecentObservedDrawAtSelectedStep = resolveHasRecentObservedDrawAtSelectedStep(
    ctx,
    device,
  );
  const commandable = resolveCommandableNow({
    dev: {
      deviceClass: device.deviceClass,
      controlCapabilityId: device.controlCapabilityId,
      evChargingState: device.evChargingState,
      available: device.available,
    },
  });
  const canSetControlResolved = resolveCanSetControl({
    controlCapabilityId: device.controlCapabilityId,
    capabilities: device.capabilities,
    canSetControl: device.canSetControl,
    canSetOnOff: (device as TargetDeviceSnapshot & { canSetOnOff?: boolean }).canSetOnOff,
  });
  const shedBehavior = ctx.getShedBehavior(device.id);
  const controllable = ctx.isCapacityControlEnabled(device.id);
  const residualKw = buildResidualKwForPlanDevice({
    device,
    controlCapabilityId: device.controlCapabilityId,
    shedBehavior,
  });
  return {
    ...device,
    // The step-command/planning cluster used to ride in on the `...device`
    // spread when it lived on `TargetDeviceSnapshot`. It now originates on the
    // decoration carrier (`DecoratedDeviceSnapshot`); copy each field
    // explicitly so the laundering into `PlanInputDevice` stays visible and
    // independent of the carrier's shape. Values are byte-identical to the
    // pre-decomposition spread.
    selectedStepId: device.selectedStepId,
    planningPowerKw: device.planningPowerKw,
    targetStepId: device.targetStepId,
    desiredStepId: device.desiredStepId,
    previousStepId: device.previousStepId,
    lastStepCommandIssuedAt: device.lastStepCommandIssuedAt,
    stepCommandRetryCount: device.stepCommandRetryCount,
    nextStepCommandRetryAtMs: device.nextStepCommandRetryAtMs,
    stepCommandPending: device.stepCommandPending,
    stepCommandStatus: device.stepCommandStatus,
    observationStale: isDeviceObservationStale(device),
    managed: ctx.resolveManagedState(device.id),
    controllable,
    budgetExempt: ctx.isBudgetExempt(device.id),
    temperatureBoost: ctx.getTemperatureBoostConfig?.(device.id),
    evBoost: ctx.getEvBoostConfig?.(device.id),
    binaryCommandPending: pendingBinaryCommand !== null && pendingBinaryCommand !== undefined,
    binaryCommandPendingDesired: pendingBinaryCommand?.desired,
    commandableNow: commandable.commandableNow,
    commandableNowReason: commandable.reason,
    canSetControlResolved,
    residualKw,
    ...(calibration ? { stepPowerCalibration: calibration } : {}),
    ...(hasRecentObservedDrawAtSelectedStep !== undefined
      ? { hasRecentObservedDrawAtSelectedStep }
      : {}),
  };
}

/**
 * Drop entries from `map` whose keys aren't present in `presentIds`. Used to
 * keep producer-side per-device caches bounded: without eviction, removing a
 * device from Homey at runtime would leak the entry forever. Practical
 * impact is small (~50 bytes/entry, hundreds of devices across the app's
 * lifetime), but the unbounded growth was flagged in the chunk-2 producer
 * review and is straightforward to fix.
 *
 * Callers must pass the *full* snapshot's device IDs — a filtered/partial
 * list would delete entries for devices that still exist, defeating the
 * abandon-grace window.
 */
function evictMissingFromRecord<V>(
  map: Record<string, V>,
  presentIds: ReadonlySet<string>,
): void {
  for (const id of Object.keys(map)) {
    if (!presentIds.has(id)) {
      // eslint-disable-next-line functional/immutable-data, no-param-reassign
      delete map[id];
    }
  }
}

/**
 * Per-plan-cycle sweep: evict orphan entries from the producer-owned
 * `lastKnownPowerKw` cache whose device IDs are no longer present in the
 * latest snapshot. Pass the *full* snapshot here — not a filtered view.
 *
 * Source: chunk-2 producer review flagged unbounded growth on device
 * deletion; this sweep closes that gap without changing any in-cycle
 * behaviour for devices that still exist.
 */
export function evictMissingDeviceCacheEntries(
  ctx: AppContext,
  snapshot: ReadonlyArray<TargetDeviceSnapshot>,
): void {
  const presentIds = new Set<string>(snapshot.map((device) => device.id));
  evictMissingFromRecord(ctx.lastKnownPowerKw, presentIds);
}
