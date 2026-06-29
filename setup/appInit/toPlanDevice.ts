import { isDeviceObservationStale } from '../../lib/observer/observationFreshness';
import { resolveCurrentOn, resolveObservedCurrentState } from '../../lib/observer/observedState';
import {
  resolveCanSetControl,
  resolveCommandableNow,
} from '../../lib/device/deviceActionProjection';
import { buildResidualKwForPlanDevice } from './residualKwForPlanDevice';
import type {
  DecoratedDeviceSnapshot,
  EvObservedProbe,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { AppContext } from '../../lib/app/appContext';
import {
  buildStepPowerCalibrationView,
  resolveHasRecentObservedDrawAtSelectedStep,
} from './calibrationViews';
import { withSteppedDiscriminant } from '../../lib/plan/planTypes';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

// The device param widens with `EvObservedProbe`: this producer is the one
// sanctioned reader of the raw observed `evChargingState` on the plan path —
// it resolves the flat EV sub-fields below and strips the raw field off the
// spread. The decorated snapshots the caller holds physically carry the field
// (transport writes it); the base type omits it for consumers.
export function toPlanDevice(ctx: AppContext, device: DecoratedDeviceSnapshot & EvObservedProbe): PlanInputDevice {
  // First real reader of the observer-owned observed-state projection (stage 4b).
  // The freshness fields (`lastFreshDataMs`/`lastLocalWriteMs`) are observed
  // state, so staleness is decided from the projection's maintained truth rather
  // than the snapshot.
  //
  // The `?? device` snapshot fallback is RETAINED, not retired. Boot-seeding
  // (`createPlanService.getPlanDevices` → `ctx.seedObservedStateFromSnapshot`)
  // fills the projection from the raw snapshot before this runs on the main plan
  // path, so for every device in the committed snapshot `observed` is now
  // non-empty here (a real observation or the seed) — the boot-window arm is dead
  // on that path. But two callers reach `toPlanDevice` WITHOUT that seed:
  //   1. the realtime-reconcile `getLiveDevices` (app.ts), and
  //   2. the smart-task plan preview (app.ts), which can resolve a device from
  //      `getUiPickerDevices()` that was never in the committed snapshot, so the
  //      projection has no entry — neither real nor seeded.
  // For those, `observed` can still be undefined. Dropping the fallback would
  // call `isDeviceObservationStale(undefined)` — a silent `unknown → non-stale`
  // flip (and a runtime read of a removed field once `lastFreshDataMs` /
  // `lastLocalWriteMs` leave the descriptor surface — TODO). The fallback is
  // correct today only because `TargetDeviceSnapshot` still physically carries
  // those freshness fields; retire it in lockstep with that strip, not before.
  // The resolved boolean is threaded into the residual-power credit below so both
  // freshness consumers in this build share one source.
  const observed = ctx.getObservedState(device.id);
  const observationStale = isDeviceObservationStale(observed ?? device);
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
  // A home battery or solar device is managed observe-only. Read its
  // `managed`/`controllable` from the STRUCTURAL snapshot stamp
  // (`resolveParsedDeviceSettings` set them from the device object at parse, on every
  // parse path) rather than re-resolving via the settings-derived `ctx` functions —
  // those depend on the transport's async-populated id sets, which the realtime
  // `device.update` path does not refresh, so re-resolving could briefly read
  // `controllable: true` for a device whose settings say so. The structural stamp closes
  // that window: a present observe-only device is NEVER controllable here. Other-device
  // resolution is unchanged (the stamp equals the re-resolved value).
  const isObserveOnlyRole = device.deviceClass === 'battery' || device.deviceClass === 'solarpanel';
  const controllable = isObserveOnlyRole ? device.controllable === true : ctx.isCapacityControlEnabled(device.id);
  const residualKw = buildResidualKwForPlanDevice({
    device,
    controlCapabilityId: device.controlCapabilityId,
    shedBehavior,
    observationStale,
  });
  // The plan-input device type is a discriminated union on the stepped
  // discriminant; the `...device` spread decouples `controlModel` from
  // `steppedLoadProfile`, so the whole literal is rebuilt through
  // `withSteppedDiscriminant`, which re-ties them as a single variant-shaped
  // pair. The descriptor (`TargetDeviceSnapshot`) keeps the profile as a plain
  // optional (out of scope for this slice), so `device.steppedLoadProfile` is
  // read directly here.
  // Strip the observer-owned raw `evChargingState` off the spread so it never
  // rides onto the plan device; the resolved flat EV sub-fields
  // (`evBlockReason` / `evSessionInactive` / `evChargerNotResumable`, set below
  // from `commandable`) replace it.
  const { evChargingState: _evChargingState, ...deviceFields } = device;
  return withSteppedDiscriminant({
    ...deviceFields,
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
    observationStale,
    // The four-valued observed-state label, resolved once here from the full
    // snapshot (which keeps the raw `binaryControl` + stepped descriptor) plus the
    // resolved `observationStale` above. Plan consumers
    // (`planDevices.resolveCurrentState`, `planReconcileState`) trust this producer
    // resolution instead of re-resolving from the raw binary axis, so
    // `binaryControl` can stay off the plan kinds.
    currentState: resolveObservedCurrentState({ ...device, observationStale }),
    // The public on/off truth, resolved once here for binary devices (present
    // IFF `controlCapabilityId` is set this cycle). `isBinaryPlanDevice`
    // re-asserts it as a required `boolean`; non-binary devices carry no on/off
    // truth.
    ...(device.controlCapabilityId !== undefined ? { currentOn: resolveCurrentOn(device) } : {}),
    // Observe-only role (battery/solar): structural stamp (always managed observe-only);
    // else re-resolve.
    managed: isObserveOnlyRole ? device.managed !== false : ctx.resolveManagedState(device.id),
    controllable,
    budgetExempt: ctx.isBudgetExempt(device.id),
    temperatureBoost: ctx.getTemperatureBoostConfig?.(device.id),
    evBoost: ctx.getEvBoostConfig?.(device.id),
    binaryCommandPending: pendingBinaryCommand !== null && pendingBinaryCommand !== undefined,
    binaryCommandPendingDesired: pendingBinaryCommand?.desired,
    commandableNow: commandable.commandableNow,
    commandableNowReason: commandable.reason,
    evBlockReason: commandable.evBlockReason,
    evSessionInactive: commandable.evSessionInactive,
    evChargerNotResumable: commandable.evChargerNotResumable,
    canSetControlResolved,
    residualKw,
    ...(calibration ? { stepPowerCalibration: calibration } : {}),
    ...(hasRecentObservedDrawAtSelectedStep !== undefined
      ? { hasRecentObservedDrawAtSelectedStep }
      : {}),
  });
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
