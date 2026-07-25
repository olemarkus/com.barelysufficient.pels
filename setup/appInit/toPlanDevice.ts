import { resolveCurrentOn, resolveObservedCurrentState } from '../../lib/observer/observedState';
import {
  resolveCanSetControl,
  resolveCommandableNow,
} from '../../lib/device/deviceActionProjection';
import { buildResidualKwForPlanDevice } from './residualKwForPlanDevice';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlModel,
  EvObservedProbe,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import type { AppContext } from '../../lib/app/appContext';
import {
  buildStepPowerCalibrationView,
  resolveHasRecentObservedDraw,
} from './calibrationViews';
import { withSteppedDiscriminant } from '../../lib/plan/planTypes';
import { resolveSurplusOnlyPosture } from '../../lib/plan/planSurplusAbsorb';
import { normalizePowerSource } from '../../lib/power/powerSource';
import { POWER_SOURCE } from '../../lib/utils/settingsKeys';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

// Producer-side classification for the "Run on solar surplus" dump-load gate: a
// plain binary-power control device — NOT an enabled continuous / target-power
// (EV-preset) config and NOT a non-binary control model. Resolved here (setup
// may read the control-model setting + target-power config) so the planner
// helper carries no such branch (control-model vocab rule).
const isPlainBinaryControlDevice = (
  targetPowerConfig: TargetPowerSteppedLoadConfig | undefined,
  controlModel: DeviceControlModel | undefined,
): boolean => !(targetPowerConfig !== undefined && targetPowerConfig.enabled !== false)
  && (controlModel === undefined || controlModel === 'binary_power');

/**
 * Per-home overrides for the two `toPlanDevice` reads that are otherwise
 * hardwired to the MAIN home's runtime (R7b Cluster A). Absent (the default) =
 * byte-identical to the pre-lift behavior; a sub-home capacity bundle passes
 * neutral overrides so it neither adopts a surplus posture (capacity-only, no
 * price/surplus signal) nor leaks MAIN's in-flight binary command into its own
 * drift gate.
 */
export type ToPlanDeviceOptions = {
  /** When false, skip the surplus-absorb posture entirely — never stamp `surplusOnly`. Default true. */
  surplusPostureEnabled?: boolean;
  /** In-flight binary command resolver. Default reads MAIN's engine via `ctx.planEngine`. */
  getPendingBinaryCommand?: (
    deviceId: string,
    communicationModel?: 'local' | 'cloud',
  ) => { desired: boolean } | null;
};

// Resolve the device's in-flight binary command. Default (no override) reads
// MAIN's engine via `ctx.planEngine` — byte-identical to the pre-R7b read
// (undefined when the engine/method is absent); a sub-home bundle overrides it
// to read its OWN engine (see `buildSubHomeScope.getPlanDevices`).
function resolvePendingBinaryCommand(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot & EvObservedProbe,
  opts: ToPlanDeviceOptions | undefined,
): { desired: boolean } | null | undefined {
  if (opts?.getPendingBinaryCommand) {
    return opts.getPendingBinaryCommand(device.id, device.communicationModel);
  }
  return ctx.planEngine?.getPendingBinaryCommandForDevice?.(device.id, device.communicationModel);
}

// "Run on solar surplus" dump-load posture (the flat `surplusOnly` bit),
// resolved ONCE from the per-device price-opt blob + the raw snapshot's modality
// (binary, not temperature/stepped/EV) and the resolved managed/controllable
// bits. The planner's allocator/hold and the executor's carve-out stamp consume
// it; nothing downstream re-reads the blob.
//
// Producer-resolved metered-source gate: on the flow power source no surplus
// signal exists (the flow boundary rejects negative watts and carries no
// generation channel), so a dump load must never be stamped `surplusOnly` there
// — the surplus hold would otherwise keep it off forever. A transient
// `settings.get` miss reads as flow (fail-toward-release): the device reverts to
// normal managed control for that cycle rather than being stranded held.
// `surplusOnly` is a per-cycle derived posture, not persisted state.
//
// A sub-home capacity bundle (`surplusPostureEnabled === false`) is strictly
// capacity-only — no price/surplus signal — so it must NEVER stamp the posture
// (a `surplusWilling` device there could never satisfy a surplus that never
// arrives, and would be held OFF forever). Default (undefined) resolves exactly
// as the main home did before this lift.
/**
 * "Leave off until turned on again" (flat `externalOffHoldActive` bit).
 *
 * The stored hold only has planning effect while the device is STILL observed
 * off: pairing the two here means a hold whose release event was missed cannot
 * make the planner treat a running device as inactive. Binary-capability
 * devices only — without a binary control handle there is no `currentOn` truth
 * to contradict, and a step-only device's off step is weaker evidence than the
 * explicit binary state v1 requires.
 */
export function resolveExternalOffHoldActive(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot & EvObservedProbe,
): boolean {
  if (device.controlCapabilityId === undefined) return false;
  if (ctx.externalOffHold?.isHeld(device.id) !== true) return false;
  return !resolveCurrentOn(device);
}

/**
 * Device-id form of {@link resolveExternalOffHoldActive}, for the executor's
 * plan-less-safe guard. Same resolution as the producer, so the planner and the
 * executor can never disagree about whether a device is held. A device with no
 * snapshot falls back to the raw hold (conservative: do not resume something we
 * cannot see).
 */
export function isExternalOffHeldForDevice(ctx: AppContext, deviceId: string): boolean {
  const snapshot = ctx.deviceManager?.getSnapshotByDeviceId(deviceId);
  if (!snapshot) return ctx.externalOffHold?.isHeld(deviceId) === true;
  return resolveExternalOffHoldActive(ctx, snapshot);
}

function resolveSurplusPostureForDevice(params: {
  ctx: AppContext;
  device: DecoratedDeviceSnapshot & EvObservedProbe;
  opts: ToPlanDeviceOptions | undefined;
  plainBinaryControlModel: boolean;
  controllable: boolean;
  managed: boolean;
}): boolean {
  const {
    ctx, device, opts, plainBinaryControlModel, controllable, managed,
  } = params;
  if (opts?.surplusPostureEnabled === false) return false;
  return resolveSurplusOnlyPosture({
    surplusWilling: ctx.priceOptimizationSettings[device.id]?.surplusWilling,
    controlCapabilityId: device.controlCapabilityId,
    deviceClass: device.deviceClass,
    targets: device.targets,
    steppedLoadProfile: device.steppedLoadProfile,
    plainBinaryControlModel,
    controllable,
    managed,
    meteredPowerSource: normalizePowerSource(ctx.homey.settings.get(POWER_SOURCE)) === 'homey_energy',
  });
}

// The device param widens with `EvObservedProbe`: this producer is the one
// sanctioned reader of the raw observed `evChargingState` on the plan path —
// it resolves the flat EV sub-fields below and strips the raw field off the
// spread. The decorated snapshots the caller holds physically carry the field
// (transport writes it); the base type omits it for consumers.
export function toPlanDevice(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot & EvObservedProbe,
  opts?: ToPlanDeviceOptions,
): PlanInputDevice {
  // Both reads reproduce the pre-R7b wiring EXACTLY when `opts` is absent (the
  // main home): surplus posture enabled, pending-binary read via `ctx.planEngine`
  // (MAIN's engine). A sub-home bundle overrides both — see
  // `buildSubHomeScope.getPlanDevices`.
  //
  // Staleness is no longer resolved here: the producer emits the CONCRETE latched
  // observed state (`currentState`/`currentOn`), never an 'unknown' driven by
  // staleness, and the plan device carries no staleness flag. Freshness reporting
  // (overview gray-state, idle classifier, diagnostics) is sourced from the
  // observer projection at its own wiring seams (`getObservationStale`).
  const pendingBinaryCommand = resolvePendingBinaryCommand(ctx, device, opts);
  const calibration = buildStepPowerCalibrationView(ctx, device);
  const hasRecentObservedDraw = resolveHasRecentObservedDraw(
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
  const managed = isObserveOnlyRole ? device.managed !== false : ctx.resolveManagedState(device.id);
  // The continuous / target-power / non-binary classification is resolved HERE
  // (the producer may read the `controlModel` setting + target-power config) so
  // the planner helper carries no such branch (control-model vocab rule).
  const plainBinaryControlModel = isPlainBinaryControlDevice(
    device.targetPowerConfig,
    device.controlModel,
  );
  const externalOffHoldActive = resolveExternalOffHoldActive(ctx, device);
  // "Run on solar surplus" dump-load posture (flat `surplusOnly` bit). Resolved
  // in a helper (main-home default vs sub-home capacity-only) — see
  // `resolveSurplusPostureForDevice`.
  const surplusOnly = resolveSurplusPostureForDevice({
    ctx,
    device,
    opts,
    plainBinaryControlModel,
    controllable,
    managed,
  });
  const residualKw = buildResidualKwForPlanDevice({
    device,
    controlCapabilityId: device.controlCapabilityId,
    shedBehavior,
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
    // The four-valued observed-state label, resolved once here from the full
    // snapshot (which keeps the raw `binaryControl` + stepped descriptor). The
    // producer emits the CONCRETE latched label (never 'unknown' from staleness);
    // plan consumers (`planDevices.resolveCurrentState`, `planReconcileState`)
    // trust this producer resolution instead of re-resolving from the raw binary
    // axis, so `binaryControl` can stay off the plan kinds.
    currentState: resolveObservedCurrentState(device),
    // The public on/off truth, resolved once here for binary devices (present
    // IFF `controlCapabilityId` is set this cycle). `isBinaryPlanDevice`
    // re-asserts it as a required `boolean`; non-binary devices carry no on/off
    // truth.
    ...(device.controlCapabilityId !== undefined ? { currentOn: resolveCurrentOn(device) } : {}),
    // Observe-only role (battery/solar): structural stamp (always managed observe-only);
    // else re-resolve.
    managed,
    controllable,
    ...(surplusOnly ? { surplusOnly: true as const } : {}),
    ...(externalOffHoldActive ? { externalOffHoldActive: true as const } : {}),
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
    ...(hasRecentObservedDraw !== undefined
      ? { hasRecentObservedDraw }
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
