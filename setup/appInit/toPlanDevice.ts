import { resolveCurrentOn, resolveObservedCurrentState } from '../../lib/observer/observedState';
import { getCurrentDrawKw } from '../../lib/observer/observedPower';
import { resolveCanSetControl } from '../../lib/device/deviceActionProjection';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { isEvSessionInactive } from '../../packages/shared-domain/src/evPlugState';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import {
  buildResidualKwForPlanDevice,
  type ResidualKwForPlanDeviceShedBehavior,
} from './residualKwForPlanDevice';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlModel,
  EvObservedProbe,
  MeasuredPowerObservedProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
  TemperatureObservedProbe,
} from '../../packages/contracts/src/types';
import type { AppContext } from '../../lib/app/appContext';
import type { TransportControlBindingProbe } from '../../lib/device/transportDeviceSnapshot';
import type { BinaryCommandabilityProjection } from '../../lib/plan/admission/binaryCommandReachability';
import {
  buildStepPowerCalibrationView,
  resolveHasRecentObservedDraw,
} from './calibrationViews';
import { withSteppedDiscriminant } from '../../lib/plan/planTypes';
import type { SteppedClusterFields } from '../../lib/plan/planTypes';
import {
  getSteppedLoadLowestActiveStep,
  resolveSteppedLoadPlanningPowerKw,
} from '../../lib/utils/deviceControlProfiles';
import { resolveSurplusOnlyPosture } from '../../lib/plan/planSurplusAbsorb';
import { resolveSurplusPoolReachable } from '../../packages/shared-domain/src/solar/surplusPoolReachable';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import {
  resolveEvTargetPowerPlannerProfile,
  withoutTargetPowerReachability,
} from '../../lib/device/targetPowerReachability';

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
  getPendingBinaryCommand?: (deviceId: string) => { desired: boolean } | null;
  /** Owning-home PELS-OFF provenance cleanup for pull-observed ON. */
  clearRecentBinaryOffCommand?: (
    deviceId: string,
    observedOnAtMs: number,
  ) => void;
  projectCommandability?: (params: {
    deviceId: string;
    base: boolean;
    observedOn: boolean;
    available: boolean;
  }) => BinaryCommandabilityProjection;
  pruneCommandability?: (presentDeviceIds: ReadonlySet<string>) => void;
};

// Resolve the device's in-flight binary command. Default (no override) reads
// MAIN's engine via `ctx.planEngine` — byte-identical to the pre-R7b read
// (undefined when the engine/method is absent); a sub-home bundle overrides it
// to read its OWN engine (see `buildSubHomeScope.getPlanDevices`).
function resolvePendingBinaryCommand(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe & TemperatureObservedProbe,
  opts: ToPlanDeviceOptions | undefined,
): { desired: boolean } | null | undefined {
  if (opts?.getPendingBinaryCommand) {
    return opts.getPendingBinaryCommand(device.id);
  }
  return ctx.planEngine?.getPendingBinaryCommandForDevice?.(device.id);
}

function resolvePlanCommandability(
  device: DecoratedDeviceSnapshot & EvObservedProbe,
  opts: ToPlanDeviceOptions | undefined,
): BinaryCommandabilityProjection {
  const base = resolveCommandableNow(device);
  return opts?.projectCommandability?.({
    deviceId: device.id,
    base,
    observedOn: resolveCurrentOn(device),
    available: device.available,
  }) ?? { commandableNow: base, reason: 'none' };
}

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
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe,
): boolean {
  if (device.binaryControl === undefined) return false;
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

/**
 * "Run on solar surplus" dump-load posture (the flat `surplusOnly` bit),
 * resolved ONCE from the per-device price-opt blob + the raw snapshot's modality
 * (binary, not temperature/stepped/EV) and the resolved managed/controllable
 * bits. The planner's allocator/hold and the executor's carve-out stamp consume
 * it; nothing downstream re-reads the blob. `surplusOnly` is a per-cycle derived
 * posture, not persisted state.
 *
 * Gated on whether the home's surplus pool can EVER open
 * (`resolveSurplusPoolReachable`), not on the power source. The source-name gate
 * this replaces reasoned from "the flow boundary rejects negative watts", which
 * stopped being true when that card began accepting signed watts — but deleting
 * it outright re-opened the trap it had been holding shut. Stamping the posture
 * where no surplus can arrive does not leave a device merely idle: the standing
 * hold keeps it OFF indefinitely, with no time-based escape and no UI recourse.
 * Every flow install whose Flow predates signed watts is in exactly that state,
 * through no fault of its own.
 *
 * The evidence is read fresh each cycle from the whole-home tracker and the
 * curtailment estimator, so a home that starts sending signed net earns the
 * posture on its own once export accrues — no restart, no settings change.
 *
 * The removed source gate also aborted this producer cycle on a suspect settings
 * read (`requireConfiguredPowerSource` throws). That abort existed to stop a
 * transient read stamping an authoritative Flow posture — a hazard that only
 * existed because the posture depended on the source. It no longer does, so
 * there is nothing left for the abort to protect.
 *
 * A sub-home capacity bundle (`surplusPostureEnabled === false`) is strictly
 * capacity-only — no price/surplus signal — so it must NEVER stamp the posture
 * (a `surplusWilling` device there could never satisfy a surplus that never
 * arrives, and would be held OFF forever). That fencing is a different
 * mechanism and is unchanged.
 */
function resolveSurplusPostureForDevice(params: {
  ctx: AppContext;
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe;
  opts: ToPlanDeviceOptions | undefined;
  plainBinaryControlModel: boolean;
  controllable: boolean;
  managed: boolean;
}): boolean {
  const {
    ctx, device, opts, plainBinaryControlModel, controllable, managed,
  } = params;
  if (device.temperatureControlDisabled === true) return false;
  if (opts?.surplusPostureEnabled === false) return false;
  return resolveSurplusOnlyPosture({
    surplusWilling: ctx.priceOptimizationSettings[device.id]?.surplusWilling,
    hasBinaryControl: device.binaryControl !== undefined,
    objectiveKind: isEvObserved(device) ? 'ev_soc' : undefined,
    targets: device.targets,
    steppedLoadProfile: device.steppedLoadProfile,
    plainBinaryControlModel,
    controllable,
    managed,
    surplusPoolReachable: resolveSurplusPoolReachable({
      tracker: ctx.powerTracker,
      // Absent only until the post-startup wiring runs. False is the better
      // default (a wrongly-stamped device is held off indefinitely, while an
      // unstamped one is merely turned on from grid headroom by the generic
      // restore lane) — but it is not free, so the underlying evidence is
      // persisted rather than re-earned each boot.
      curtailmentCanContribute: ctx.canContributeCurtailmentSurplus?.() === true,
    }),
  });
}

/**
 * Project the app-layer command-authority override into the planner's input
 * vocabulary. Observation remains on the decorated snapshot served to the UI;
 * the plan sees only the commands PELS is currently allowed to issue.
 */
/**
 * The stepped cluster, built as a UNIT — this is the boundary where the optional
 * originates, so it is the only place that can make `SteppedLoadKind`'s required
 * `planningPowerKw` mean anything. The decoration carrier types the field as a
 * plain optional; copying it straight through was how an absent value could
 * reach a plan device that declares it required.
 *
 * The decorator resolved the number against the CONFIRMED profile, but the
 * planner may run a different one (`resolveEvTargetPowerPlannerProfile`
 * substitutes an EV target-power ladder), so recompute against the profile the
 * planner will actually use and fall back to the carried value. Neither rung
 * invents anything: both read `planningPowerW` off a step of the profile in hand.
 *
 * When neither resolves, the ladder yields no planning power at all — and the
 * honest answer is that this device is not stepped-controllable, the same
 * verdict `asSteppedLoadProfile` reaches upstream when it refuses a ladder with
 * no rung above zero. Returning `{}` says that, instead of shipping a stepped
 * device with a hole where its power should be.
 */
function resolveSteppedClusterFields(
  plannerSteppedLoadProfile: SteppedLoadProfile | undefined,
  device: { selectedStepId?: string; planningPowerKw?: number },
): SteppedClusterFields {
  if (!plannerSteppedLoadProfile) return {};
  // Gated on FINITENESS, not merely on presence — this is the boundary into
  // `lib/plan`, and `??` would forward a `NaN` as a resolved answer. Both
  // sources can carry one: `planningPowerW` comes from persisted settings, and
  // the carried value comes from the decoration layer. A non-finite kW that
  // reaches the planner poisons every sum it lands in — reserve, headroom,
  // restore sizing — silently rather than loudly.
  //
  // Each rung is gated separately, so a junk value FALLS THROUGH to the next
  // rung instead of short-circuiting the chain. Checking only the final value
  // would let a `NaN` first rung drop the device out of stepped control even
  // when the ladder had a perfectly good answer one rung down.
  const planningPowerKw = [
    resolveSteppedLoadPlanningPowerKw(plannerSteppedLoadProfile, device.selectedStepId),
    device.planningPowerKw,
    // The rung the EV target-power cap needs: the planner ladder can be CAPPED
    // below the device's selected step, so that step is simply not in the
    // profile the planner will run and the first rung finds nothing. Price it at
    // the ladder's own planning fallback — the same lowest-active step the
    // decorator uses when there is no reported step. Still not an invention: it
    // is a real rung of the profile in hand.
    resolveSteppedLoadPlanningPowerKw(
      plannerSteppedLoadProfile,
      getSteppedLoadLowestActiveStep(plannerSteppedLoadProfile)?.id,
    ),
  ].find((kw): kw is number => typeof kw === 'number' && Number.isFinite(kw));
  // Only reachable for a ladder no rung of which yields a finite planning power
  // — which `asSteppedLoadProfile` already refuses upstream — so this says "not
  // stepped-controllable", matching that refusal, rather than shipping a
  // stepped device with a hole where its power should be.
  if (planningPowerKw === undefined) return {};
  return { steppedLoadProfile: plannerSteppedLoadProfile, planningPowerKw };
}

/**
 * The STEP-LADDER GAP: the device is configured as a stepped load, but no live
 * ladder resolved this cycle, so the plan device will carry neither
 * `steppedLoadProfile` nor `planningPowerKw`.
 *
 * Resolved here because this is the only place both halves of it are visible at
 * once: the configured intent (`controlModel`) and the ladder the planner will
 * actually run (`steppedCluster`). Downstream the two cannot be compared —
 * `withSteppedDiscriminant` strips the whole stepped cluster from a non-stepped
 * result, so "no profile" alone cannot say whether a ladder was EXPECTED. The
 * smart-task stack needs exactly that distinction: a stepped device without its
 * ladder has no rate to plan against and must be served its frozen committed
 * plan, while a device that was never stepped may have a rate synthesised for it.
 *
 * Both ways the cluster comes up empty are the same gap and answer alike: no live
 * profile reached the snapshot (a restart before the Flow re-fires, a transient
 * SDK read), or the ladder in hand priced no rung.
 *
 * Reads the EFFECTIVE device: a temperature-disabled device has already been
 * re-projected to `binary_power`, so it is honestly not in a gap — it is not
 * stepped at all this cycle.
 */
function resolveSteppedLadderMissing(
  device: { controlModel?: DeviceControlModel },
  steppedCluster: SteppedClusterFields,
): boolean {
  return device.controlModel === 'stepped_load'
    && steppedCluster.steppedLoadProfile === undefined;
}

/**
 * The atomic temperature facet, stamped as a unit (resolution-in-producer): the
 * observer admits the facet only with BOTH a finite sensor reading and a finite
 * exact target snapshot, so `isTemperaturePlanDevice` narrows both fields to
 * required numbers. `deviceType` is DERIVED here from facet presence rather
 * than trusted off the carrier, so the discriminant and the cluster cannot
 * diverge on a plan input — a snapshot claiming `'temperature'` without the
 * facet plans as `'onoff'`, never as a half-cluster. Consumers never reach into
 * the raw `targets` list for the value.
 */
function resolveTemperatureInputFields(
  device: TemperatureObservedProbe,
): { deviceType: 'temperature'; currentTemperature: number; currentTarget: number } | { deviceType: 'onoff' } {
  if (!device.temperature) return { deviceType: 'onoff' };
  return {
    deviceType: 'temperature',
    currentTemperature: device.temperature.currentTemperature,
    currentTarget: device.temperature.target.value,
  };
}

function projectEffectiveControlDevice(
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe & TemperatureObservedProbe,
): DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe & TemperatureObservedProbe {
  if (device.temperatureControlDisabled !== true) return device;
  return {
    ...device,
    targets: [],
    temperature: undefined,
    deviceType: 'onoff',
    controlModel: 'binary_power',
    steppedLoadProfile: undefined,
    targetPowerConfig: undefined,
    controlAdapter: undefined,
    reportedStepId: undefined,
    selectedStepId: undefined,
    planningPowerKw: undefined,
    targetStepId: undefined,
    desiredStepId: undefined,
    previousStepId: undefined,
    lastStepCommandIssuedAt: undefined,
    stepCommandRetryCount: undefined,
    nextStepCommandRetryAtMs: undefined,
    stepCommandPending: undefined,
    stepCommandStatus: undefined,
  };
}

function resolveEffectiveShedBehavior(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe & TemperatureObservedProbe,
): ResidualKwForPlanDeviceShedBehavior {
  if (device.temperatureControlDisabled === true) {
    return { action: 'turn_off' };
  }
  const configured = ctx.getShedBehavior(device.id);
  if (configured.action === 'set_temperature') {
    if (device.temperature === undefined) return resolveShedBehaviorWithoutTemperature(device);
    return typeof configured.temperature === 'number' && Number.isFinite(configured.temperature)
      ? { action: 'set_temperature', temperature: configured.temperature }
      : { action: 'turn_off' };
  }
  if (configured.action === 'set_step') {
    const stepId = configured.stepId
      ?? (isSteppedLoadSnapshot(device)
        ? getSteppedLoadLowestActiveStep(device.steppedLoadProfile)?.id
        : undefined);
    return stepId ? { action: 'set_step', stepId } : { action: 'turn_off' };
  }
  return { action: 'turn_off' };
}

function resolveShedBehaviorWithoutTemperature(
  device: DecoratedDeviceSnapshot,
): ResidualKwForPlanDeviceShedBehavior {
  if (device.binaryControl !== undefined) return { action: 'turn_off' };
  if (!isSteppedLoadSnapshot(device)) return { action: 'turn_off' };
  const lowestActiveStep = getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  return lowestActiveStep
    ? { action: 'set_step', stepId: lowestActiveStep.id }
    : { action: 'turn_off' };
}

function resolveEffectiveTemperatureBoost(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe & TemperatureObservedProbe,
) {
  if (device.temperatureControlDisabled === true) return undefined;
  return ctx.getTemperatureBoostConfig?.(device.id);
}

type PlanCommandabilityReason = PlanInputDevice['commandabilityReason'];

function resolvePlanCommandabilityReason(
  device: DecoratedDeviceSnapshot & EvObservedProbe,
): PlanCommandabilityReason | undefined {
  if (device.available === false) return 'device_unavailable';
  if (device.evChargingState === 'plugged_out') return 'charger_unplugged';
  if (device.evChargingState === 'plugged_in_discharging') return 'charger_discharging';
  return undefined;
}

function resolvePlanObjective(
  device: DecoratedDeviceSnapshot & EvObservedProbe,
): Pick<PlanInputDevice, 'objectiveKind' | 'objectiveSessionInactive'> {
  if (isEvObserved(device)) {
    return {
      objectiveKind: 'ev_soc',
      objectiveSessionInactive: isEvSessionInactive(device.evChargingState),
    };
  }
  return {
    objectiveKind: device.targets.length > 0 ? 'temperature' : undefined,
    objectiveSessionInactive: false,
  };
}

function resolveManagedControlPosture(
  ctx: AppContext,
  device: DecoratedDeviceSnapshot,
): { controllable: boolean; managed: boolean } {
  const observeOnly = device.deviceClass === 'battery' || device.deviceClass === 'solarpanel';
  if (observeOnly) {
    return {
      controllable: device.controllable === true,
      managed: device.managed !== false,
    };
  }
  return {
    controllable: ctx.isCapacityControlEnabled(device.id),
    managed: ctx.resolveManagedState(device.id),
  };
}

// The device param widens with `EvObservedProbe`: this producer is the one
// sanctioned reader of the raw observed `evChargingState` on the plan path —
// it resolves the flat EV sub-fields below and strips the raw field off the
// spread. The decorated snapshots the caller holds physically carry the field
// (transport writes it); the base type omits it for consumers.
export function toPlanDevice(
  ctx: AppContext,
  rawDevice: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe & TemperatureObservedProbe,
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
  const device = projectEffectiveControlDevice(rawDevice);
  const plannerSteppedLoadProfile = isSteppedLoadSnapshot(device)
    ? resolveEvTargetPowerPlannerProfile({
      config: ctx.deviceTargetPowerConfigs[device.id] ?? device.targetPowerConfig,
      confirmedProfile: device.steppedLoadProfile,
      nowMs: ctx.getNow().getTime(),
    })
    : undefined;
  const steppedCluster = resolveSteppedClusterFields(plannerSteppedLoadProfile, device);
  // The step-ladder gap — see `resolveSteppedLadderMissing`.
  const steppedLadderMissing = resolveSteppedLadderMissing(device, steppedCluster);
  const pendingBinaryCommand = resolvePendingBinaryCommand(ctx, device, opts);
  const calibration = buildStepPowerCalibrationView(ctx, device);
  const hasRecentObservedDraw = resolveHasRecentObservedDraw(
    ctx,
    device,
  );
  const commandability = resolvePlanCommandability(device, opts);
  const commandableNow = commandability.commandableNow;
  const commandabilityReason = commandability.reason === 'binary_command_retry'
    ? commandability.reason
    : resolvePlanCommandabilityReason(device);
  const objective = resolvePlanObjective(device);
  const canSetControlResolved = resolveCanSetControl({
    binaryControl: device.binaryControl,
    capabilities: device.capabilities,
    canSetControl: device.canSetControl,
    canSetOnOff: (device as TargetDeviceSnapshot & { canSetOnOff?: boolean }).canSetOnOff,
  });
  const shedBehavior = resolveEffectiveShedBehavior(ctx, device);
  // A home battery or solar device is managed observe-only. Read its
  // `managed`/`controllable` from the STRUCTURAL snapshot stamp
  // (`resolveParsedDeviceSettings` set them from the device object at parse, on every
  // parse path) rather than re-resolving via the settings-derived `ctx` functions —
  // those depend on the transport's async-populated id sets, which the realtime
  // `device.update` path does not refresh, so re-resolving could briefly read
  // `controllable: true` for a device whose settings say so. The structural stamp closes
  // that window: a present observe-only device is NEVER controllable here. Other-device
  // resolution is unchanged (the stamp equals the re-resolved value).
  const { controllable, managed } = resolveManagedControlPosture(ctx, device);
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
    hasBinaryControl: device.binaryControl !== undefined,
    shedBehavior,
  });
  // The plan-input device type is a discriminated union on the stepped
  // discriminant; the `...device` spread decouples `controlModel` from
  // `steppedLoadProfile`, so the whole literal is rebuilt through
  // `withSteppedDiscriminant`, which re-ties them as a single variant-shaped
  // pair. The descriptor (`TargetDeviceSnapshot`) keeps the profile as a plain
  // optional (out of scope for this slice), so `device.steppedLoadProfile` is
  // read directly here.
  // Raw transport bindings and observations are stripped before planning.
  const {
    binaryCapabilityId: _binaryCapabilityId,
    binaryWriteCapabilityId: _binaryWriteCapabilityId,
    binaryObservationCapabilityId: _binaryObservationCapabilityId,
    flowBackedCapabilityIds: _flowBackedCapabilityIds,
    temperatureControlDisabled: _temperatureControlDisabled,
    steppedLoadProfile: _confirmedSteppedLoadProfile,
    targetPowerConfig: _targetPowerConfig,
    // Strip the RAW reading too. It is absent from the plan contract by type, but
    // a spread would still carry it at runtime — invisible to tsc and readable by
    // any structural consumer, which is exactly the second competing answer this
    // change exists to remove. `currentDrawKw` below is the only answer.
    measuredPowerKw: _measuredPowerKw,
    // Same discipline, binary axis. `withBinaryDiscriminant` strips these when the
    // plan OUTPUT is regrouped (`planDevicesBase`), but this producer attaches
    // `currentOn` itself without routing through it, so the spread would carry the
    // raw observed binary evidence onto every plan INPUT at runtime — making the
    // contract's "binaryControl no longer rides on the plan kinds" true for tsc
    // and false in memory. `currentState`/`currentOn` below are the only answers;
    // the binary settle reads its evidence off the device snapshot
    // (`getSettleDevices`), never off a plan device.
    binaryControl: _binaryControl,
    binaryControlObservation: _binaryControlObservation,
    evChargingState: _evChargingState,
    temperature: _temperature,
    ...deviceFields
  } = device as typeof device & TransportControlBindingProbe & EvObservedProbe & TemperatureObservedProbe;
  return withSteppedDiscriminant({
    ...deviceFields,
    ...steppedCluster,
    targetPowerConfig: withoutTargetPowerReachability(device.targetPowerConfig),
    // The step-command/planning cluster used to ride in on the `...device`
    // spread when it lived on `TargetDeviceSnapshot`. It now originates on the
    // decoration carrier (`DecoratedDeviceSnapshot`); copy each field
    // explicitly so the laundering into `PlanInputDevice` stays visible and
    // independent of the carrier's shape. Values are byte-identical to the
    // pre-decomposition spread.
    selectedStepId: device.selectedStepId,
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
    // plan consumers (`planDevices.resolveCurrentState`, `planLiveStateMerge`)
    // trust this producer resolution instead of re-resolving from the raw binary
    // axis, so `binaryControl` can stay off the plan kinds.
    currentState: resolveObservedCurrentState(device),
    // The public on/off truth, resolved once here for binary devices (present
    // IFF the observer resolved a binary axis this cycle). `isBinaryPlanDevice`
    // re-asserts it as a required `boolean`; non-binary devices carry no on/off
    // truth.
    ...(device.binaryControl !== undefined ? { currentOn: resolveCurrentOn(device) } : {}),
    // Observe-only role (battery/solar): structural stamp (always managed observe-only);
    // else re-resolve.
    managed,
    controllable,
    available: device.available,
    ...(surplusOnly ? { surplusOnly: true as const } : {}),
    ...(externalOffHoldActive ? { externalOffHoldActive: true as const } : {}),
    // Flat producer-resolved step-ladder gap — see `steppedLadderMissing` above.
    // Stamped only when true, so the absent case has one spelling.
    ...(steppedLadderMissing ? { steppedLadderMissing: true as const } : {}),
    budgetExempt: ctx.isBudgetExempt(device.id),
    temperatureBoost: resolveEffectiveTemperatureBoost(ctx, device),
    evBoost: ctx.getEvBoostConfig?.(device.id),
    binaryCommandPending: pendingBinaryCommand !== null && pendingBinaryCommand !== undefined,
    binaryCommandPendingDesired: pendingBinaryCommand?.desired,
    commandableNow,
    ...(commandabilityReason ? { commandabilityReason } : {}),
    ...objective,
    canSetControlResolved,
    residualKw,
    // The single place the device's draw is decided: the meter's reading, or 0.
    // The raw field is stripped from the spread above, so no consumer can reach
    // past this answer to a second one.
    currentDrawKw: getCurrentDrawKw(device),
    ...resolveTemperatureInputFields(device),
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
 *
 * AN EMPTY SNAPSHOT EVICTS NOTHING. Homey SDK reads fail transiently, and a
 * refresh that comes back empty is overwhelmingly "the read failed", not "the
 * user deleted every device" — a home with no devices at all has nothing to
 * evict either way, so the guard costs nothing and the symmetric mistake is
 * expensive. It used to be merely wasteful, because the peak was in-memory and a
 * restart rebuilt it; now that the store is persisted, one bad read would
 * otherwise erase learning the fleet took weeks to accumulate
 * (`feedback_homey_sdk_unreliable`, `notes/persisted-settings-state.md`).
 *
 * `expectedPowerKwOverrides` is deliberately NOT swept here. It is the owner's
 * own configuration, and the snapshot is a MANAGED view — the managed filter
 * drops devices from it — so evicting on absence would delete a saved figure the
 * moment someone un-manages a device, and silently fail to restore it when they
 * changed their mind. It is bounded by the number of devices a person has ever
 * typed a figure for.
 */
export function evictMissingDeviceCacheEntries(
  ctx: AppContext,
  snapshot: ReadonlyArray<TargetDeviceSnapshot>,
): void {
  if (snapshot.length === 0) return;
  const presentIds = new Set<string>(snapshot.map((device) => device.id));
  evictMissingFromRecord(ctx.lastKnownPowerKw, presentIds);
}
