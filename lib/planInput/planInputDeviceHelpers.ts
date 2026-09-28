import { resolveCurrentOn } from '../observer/observedState';
import {
  type BoostResolveInput,
  resolveBoostRequested,
  resolveBoostSupported,
} from '../device/deviceActionProjection';
import { isEvSessionInactive } from '../../packages/shared-domain/src/evPlugState';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { resolveResidualShedBehavior, type ResidualKwForPlanDeviceShedBehavior } from './residualKwForPlanDevice';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlModel,
  EvObservedProbe,
  MeasuredPowerObservedProbe,
  SteppedLoadProfile,
  TargetPowerSteppedLoadConfig,
  TemperatureObservedProbe,
} from '../../packages/contracts/src/types';
import type { DeviceControlPosture, TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';
import type { BinaryCommandabilityProjection } from '../plan/admission/binaryCommandReachability';
import type { SteppedClusterFields } from '../plan/planTypes';
import {
  getSteppedLoadLowestActiveStep,
  resolveSteppedLoadPlanningPowerKw,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import {
  resolveSurplusOnlyPosture,
  resolveSurplusTrackingPosture,
} from '../plan/planSurplusAbsorb';
import type { PlanInputDevice } from '../plan/planTypes';
import type {
  PlanInputProjectionSource,
  ToPlanDeviceOptions,
} from './planInputDeviceTypes';

export const isPlainBinaryControlDevice = (
  targetPowerConfig: TargetPowerSteppedLoadConfig | undefined,
  controlModel: DeviceControlModel | undefined,
): boolean => !(targetPowerConfig !== undefined && targetPowerConfig.enabled !== false)
  && (controlModel === undefined || controlModel === 'binary_power');

export function resolvePlanCommandability(
  device: DecoratedDeviceSnapshot & EvObservedProbe,
  opts: ToPlanDeviceOptions,
  base: boolean,
): BinaryCommandabilityProjection {
  return opts.projectCommandability({
    deviceId: device.id,
    base,
    observedOn: resolveCurrentOn(device),
    available: device.available,
  });
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
/**
 * Both non-temperature surplus postures — the "Run on solar surplus" dump-load
 * bit (`surplusOnly`) and the "Match solar surplus" tracking bit
 * (`surplusTracking`) — resolved ONCE from the per-device price-opt blob + the
 * raw snapshot's modality and the resolved managed/controllable bits. The
 * planner's allocator/hold and the executor's carve-out stamp consume them;
 * nothing downstream re-reads the blob. Both are per-cycle derived postures, not
 * persisted state.
 *
 * The two are mutually exclusive by construction rather than by precedence: the
 * dump-load bit requires a plain binary control model and a non-stepped
 * snapshot, the tracking bit requires a step ladder. One `surplusWilling`
 * opt-in, three modalities, and the device's own shape picks which one it gets.
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
 * The answer is read each cycle from the two persisted latches behind it (the
 * feed's recorded export, `lib/power/signedExportLatch.ts`, and the curtailment
 * estimator's armed bit), so a home that starts sending signed net earns the
 * posture on its own once export accrues — no restart, no settings change —
 * and resetting or pruning usage history cannot take it away.
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
export function resolveSurplusPostureForDevice(
  source: PlanInputProjectionSource,
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe,
  opts: ToPlanDeviceOptions,
  control: DeviceControlPosture,
): { surplusOnly: boolean; surplusTracking: boolean } {
  const none = { surplusOnly: false, surplusTracking: false };
  if (device.temperatureControlDisabled === true) return none;
  if (!opts.surplusPostureEnabled) return none;
  // A missing per-device entry means the owner has not opted this device in.
  // Resolve that absence here so the planner receives a complete decision and
  // can trust the boolean without knowing settings-map provenance.
  const surplusWilling = source.getPriceOptimizationSettings(device.id)?.surplusWilling ?? false;
  const surplusPoolReachable = source.isSurplusPoolReachable();
  const plainBinaryControlModel = isPlainBinaryControlDevice(
    device.targetPowerConfig,
    device.controlModel,
  );
  const hasStandingDemand = !isEvObserved(device);
  // The two postures are mutually exclusive by construction — the binary one
  // requires `plainBinaryControlModel` and a non-stepped snapshot, the tracking
  // one requires a step ladder — so this is a modality split, not a precedence.
  return {
    surplusOnly: resolveSurplusOnlyPosture({
      surplusWilling,
      hasBinaryControl: device.binaryControl !== undefined,
      hasStandingDemand,
      targets: device.targets,
      steppedLoadProfile: device.steppedLoadProfile,
      plainBinaryControlModel,
      control,
      surplusPoolReachable,
    }),
    surplusTracking: resolveSurplusTrackingPosture({
      surplusWilling,
      targets: device.targets,
      steppedLoadProfile: device.steppedLoadProfile,
      control,
      surplusPoolReachable,
    }),
  };
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
export function resolveSteppedClusterFields(
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
  // The effective step is part of the cluster: the decorator resolves it for
  // every device with a usable ladder (reported step ?? lowest-active
  // fallback), so an absent value here is a producer bug — refuse the whole
  // cluster ("drop contract violators"), the same verdict as the
  // no-finite-planning-power refusal above; `resolveSteppedLadderMissing` then
  // stamps the gap. The value is carried VERBATIM even when the EV target-power
  // substitution capped it out of the planner ladder — membership checks
  // downstream are real domain questions.
  if (device.selectedStepId === undefined) return {};
  return {
    steppedLoadProfile: plannerSteppedLoadProfile,
    selectedStepId: device.selectedStepId,
    planningPowerKw,
  };
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
 * Every way the cluster comes up empty is the same gap and answers alike: no live
 * profile reached the snapshot (a restart before the Flow re-fires, a transient
 * SDK read), the ladder in hand priced no rung, or the ladder resolved but named
 * no selected step (the third arm — a half cluster is refused whole rather than
 * shipped with a hole).
 *
 * Reads the EFFECTIVE device: a temperature-disabled device has already been
 * re-projected to `binary_power`, so it is honestly not in a gap — it is not
 * stepped at all this cycle.
 */
export function resolveSteppedLadderMissing(
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
export function resolveTemperatureInputFields(
  device: TemperatureObservedProbe,
): ({ deviceType: 'temperature' } & TemperaturePlanInputKind) | { deviceType: 'onoff' } {
  if (!device.temperature) return { deviceType: 'onoff' };
  return {
    deviceType: 'temperature',
    currentTemperature: device.temperature.currentTemperature,
    currentTarget: device.temperature.target.value,
  };
}

export function resolveEffectiveShedBehavior(
  source: PlanInputProjectionSource,
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe & TemperatureObservedProbe,
): ResidualKwForPlanDeviceShedBehavior {
  // The ctx lookup is the only half that belongs here; the projection onto the
  // device is pure and lives beside the residual builder, so the fixture
  // builders resolve it through the same function.
  return resolveResidualShedBehavior(source.getShedBehavior(device.id), device);
}

export function resolveEffectiveTemperatureBoost(
  source: PlanInputProjectionSource,
  device: DecoratedDeviceSnapshot & EvObservedProbe & MeasuredPowerObservedProbe & TemperatureObservedProbe,
) {
  if (device.temperatureControlDisabled === true) return undefined;
  return source.getTemperatureBoostConfig(device.id);
}

/**
 * The two boost bits the planner plans on. This is the only place the boost
 * question is asked at all: the ladder, the drivability, the configured floors
 * and the measured values against them all resolve HERE, and the planner
 * receives two booleans.
 *
 * The drivability gate matters here in a way it could not on the old plan-side
 * call: `evChargingState` is stripped from `PlanInputDevice`, so the planner
 * could never see one and an unplugged charger below its SoC floor boosted
 * anyway. Resolved at the producer, `commandableNow` carries that answer, so the
 * gate finally binds — and it binds for every device rather than for chargers
 * specifically.
 */
export function resolvePlanBoostFields(
  boostInput: BoostResolveInput,
): Pick<PlanInputDevice, 'boostSupported' | 'boostRequested'> {
  return {
    boostSupported: resolveBoostSupported(boostInput),
    boostRequested: resolveBoostRequested(boostInput),
  };
}

type PlanCommandabilityReason = PlanInputDevice['commandabilityReason'];

export function resolvePlanCommandabilityReason(
  device: DecoratedDeviceSnapshot & EvObservedProbe,
): PlanCommandabilityReason | undefined {
  if (device.available === false) return 'device_unavailable';
  if (device.evChargingState === 'plugged_out') return 'charger_unplugged';
  if (device.evChargingState === 'plugged_in_discharging') return 'charger_discharging';
  return undefined;
}

export function resolvePlanObjective(
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
