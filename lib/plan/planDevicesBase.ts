import type { DeviceControlPosture } from '../../packages/planner-types/src/planInputDevice';
import type { PreparedModeTarget, PriceTargetShift } from '../../packages/planner-types/src/temperatureSetpoints';
import type {
  DevicePlanDevice, LooseDevicePlanDevice, MeteredDiscriminantProbe, PlanInputDevice, ShedAction, ShedBehavior,
  SteppedLoadKind, TemperatureKind,
} from './planTypes';
import {
  withBinaryDiscriminant, withMeteredDiscriminant, withSteppedDiscriminant, withTemperatureDiscriminant,
} from './planTypes';
import { isMeteredPlanDevice } from './planMeteredDevice';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { resolveShedIntent } from '../device/deviceActionProjection';
import { isStartPolicyHeldDevice, isStartPolicyHoldShed } from './shedding/startPolicyHold';
import { isDeferredHoldShed } from './shedding/deferredHold';
import { isChargeTargetHeldDevice, isChargeTargetHoldShed, resolveHeldChargeTarget } from './shedding/chargeTargetHold';
import { isCarCurrentRangeHeldDevice, isCarCurrentRangeHoldShed } from './shedding/carCurrentRangeHold';
import { materializeShedSnapshotFields } from './planActionMaterialization';
import { resolveSteppedLoadDirectShedStepId } from './planSteppedShedResolution';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { getHighestKnownPowerKw } from '../observer/observedPower';
import { getPrimaryTargetCapability } from '../../packages/shared-domain/src/targetCapabilities';
import {
  isPlanDeviceObservedOn,
  isSteppedLoadDevice,
  isSteppedLoadStepBelow,
  resolveSteppedKeepDesiredStepIdFor,
  resolveSteppedLoadInitialDesiredStepId,
} from './planSteppedLoad';
import { isBinaryPlanDevice } from './planBinaryDevice';
import type { StepDownRetirement } from '../planContract/executionPlan';
import type { SheddingPlan } from './shedding/types';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';

// For shed stepped-load devices at the off step, expectedPowerKw should reflect the lowest
// positive step so that restore planning uses a realistic power estimate rather than zero.
function resolveExpectedPowerKw(
  dev: PlanInputDevice,
  currentState: string,
  plannedState: 'shed' | 'keep',
  effectiveDesiredStepId: string | undefined,
): number {
  const steppedExpectedPowerKw = resolveSteppedExpectedPowerKw(dev, currentState, plannedState, effectiveDesiredStepId);
  if (steppedExpectedPowerKw !== null) return steppedExpectedPowerKw;
  // A reading can only raise the figure; without one, the producer's expected
  // draw is the whole answer.
  return isMeteredPlanDevice(dev) ? getHighestKnownPowerKw(dev).kw : dev.expectedPowerKw;
}
function resolveSteppedExpectedPowerKw(
  dev: PlanInputDevice,
  currentState: string,
  plannedState: 'shed' | 'keep',
  effectiveDesiredStepId: string | undefined,
): number | null {
  if (
    plannedState === 'keep'
    && currentState === 'off'
    && isSteppedLoadDevice(dev)
  ) {
    const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, effectiveDesiredStepId);
    if (desiredStep && desiredStep.planningPowerW > 0) {
      return desiredStep.planningPowerW / 1000;
    }
  }
  if (
    plannedState === 'shed'
    && isSteppedLoadDevice(dev)
    && isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId)
  ) {
    const lowestActiveStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
    if (lowestActiveStep) {
      return lowestActiveStep.planningPowerW / 1000;
    }
  }
  return null;
}
/**
 * What this cycle decided for one device — the pre-image of the plan device's
 * decision fields. Not a shed record: `effectiveDesiredStepId` is the KEEP rung
 * as capped by boost and the surplus ceiling, `baseReason` can be
 * `capacity_control_off`, `plannedState` is `keep` for most devices, and
 * `plannedTarget` is the mode target whenever no shed temperature applies.
 * Resolved before the plan device is built, because the construction reads all
 * of it.
 */
type PlannedDeviceDecision = {
  plannedState: 'shed' | 'keep';
  effectiveDesiredStepId: string | undefined;
  stepDownToRetire?: StepDownRetirement;
  shedDesiredStepId: string | undefined;
  baseReason: DeviceReason;
  shedAction: ShedAction;
  shedTemperature: number | null;
  releaseShedStepId: string | null;
  plannedTarget: number | undefined;
};

function resolvePlannedDeviceDecision(inputs: BasePlanDeviceInputs): PlannedDeviceDecision {
  const {
    dev, recentlyRestored,
  } = inputs;
  // The whole posture: this builder asks BOTH questions of it, and they have
  // different answers for a managed device with power limiting off.
  const { control } = dev;
  const { shedSet, shedStepTargets, shedReasons } = inputs.sheddingPlan;
  const shouldShed = shedSet.has(dev.id) || (dev.heatingPauseActive === true && dev.currentState !== 'off');
  // ONE effective shed behaviour for this DEVICE-BUILD stage, resolved before
  // either reader. (Other stages — the normalized-floor pass, restore candidate
  // pricing — still answer from the configured floor; none is reachable for a
  // held device today.) The start-policy override used to sit inside `resolveShedAction`,
  // below the rung selection that had already priced the shed from the owner's
  // CONFIGURED floor — so a `set_step` charger got its lowest active rung, the
  // materializer read that active rung as the decided end state, and the device
  // parked at 6 A under a switch promising PELS turns it off.
  const shedBehavior = resolveEffectiveShedBehavior(dev, shouldShed, inputs.shedBehavior, shedReasons);
  const shedDesiredStepId = resolveSteppedLoadDirectShedStepId(
    dev, shedBehavior, shouldShed, shedStepTargets.get(dev.id),
  );
  const isSteppedShed = isSteppedLoadDevice(dev)
    && shedDesiredStepId !== undefined
    && shedDesiredStepId !== dev.selectedStepId;
  const plannedState = resolvePlannedState(control, shouldShed || isSteppedShed);
  const { shedAction, shedTemperature, releaseShedStepId } = resolveShedAction(dev, shouldShed, shedBehavior);
  return {
    plannedState,
    ...resolvePlannedStepDecision(inputs, plannedState, shedDesiredStepId),
    shedDesiredStepId,
    // Keyed on AUTHORITY, not on power limiting. `capacityControlOff` says "PELS is
    // not controlling this device" — false the moment a smart task has contributed
    // its authority term, and the old code agreed because the task used to write
    // `controllable: true` and this line read that same flag. Reading
    // the owner's raw toggle here instead made an impossible pair reachable: a device the
    // task authorised could be planned `shed` while still carrying
    // `capacity_control_off`, which `validatePlanReasonPair` rejects outright.
    baseReason: control.commandAuthority
      ? (dev.heatingPauseActive ? { code: PLAN_REASON_CODES.heatingPause } : shedReasons.get(dev.id))
        ?? { code: PLAN_REASON_CODES.keep, detail: recentlyRestored ? 'recently restored' : null }
      : { code: PLAN_REASON_CODES.capacityControlOff },
    shedAction,
    shedTemperature,
    releaseShedStepId,
    plannedTarget: shedAction === 'set_temperature' && shedTemperature !== null
      ? shedTemperature
      : inputs.plannedTarget,
  };
}

function resolvePlannedStepDecision(
  inputs: BasePlanDeviceInputs, plannedState: PlannedDeviceDecision['plannedState'],
  shedDesiredStepId: string | undefined,
): Pick<PlannedDeviceDecision, 'effectiveDesiredStepId' | 'stepDownToRetire'> {
  const { dev, sheddingPlan, fairnessLimited, boostActive, surplusCeilingStepId } = inputs;
  // A manual device keeps its observed rung. Lifecycle release is decided separately.
  if (!dev.control.commandAuthority) return { effectiveDesiredStepId: resolveSteppedLoadInitialDesiredStepId(dev) };
  // A command from the previous configuration can sit outside this cycle's
  // allowed ladder. Keep it as command history, not as a new planner target.
  const runtimeDesiredStepId = isSteppedLoadDevice(dev)
    ? getSteppedLoadStep(dev.steppedLoadProfile, dev.desiredStepId)?.id ?? resolveSteppedLoadInitialDesiredStepId(dev)
    : dev.desiredStepId;
  const obsoleteStep = plannedState === 'keep' && !sheddingPlan.sheddingActive
    ? resolveUnneededStepDown(dev)
    : undefined;
  const step = shedDesiredStepId ?? (obsoleteStep ? dev.reportedStepId : runtimeDesiredStepId);
  const keepStep = resolveSteppedKeepDesiredStepIdFor(
    dev, plannedState, step, fairnessLimited, boostActive, surplusCeilingStepId,
  );
  // Leave the step axis undriven. A late lower report must be priced by a
  // subsequent restore decision, even if it arrives before this plan applies.
  const stepDownToRetire = keepStep === dev.reportedStepId ? obsoleteStep : undefined;
  return { effectiveDesiredStepId: stepDownToRetire ? undefined : keepStep, stepDownToRetire };
}

function resolveUnneededStepDown(dev: PlanInputDevice): StepDownRetirement | undefined {
  if (!isSteppedLoadDevice(dev) || !isPlanDeviceObservedOn(dev)) return undefined;
  if (!dev.stepCommandPending && dev.stepCommandStatus !== 'stale') return undefined;
  const issuedAtMs = dev.lastStepCommandIssuedAt;
  const requested = getSteppedLoadStep(dev.steppedLoadProfile, dev.desiredStepId);
  const reported = getSteppedLoadStep(dev.steppedLoadProfile, dev.reportedStepId);
  if (issuedAtMs === undefined || !requested || !reported) return undefined;
  if (reported.planningPowerW <= requested.planningPowerW) return undefined;
  return drawShowsLowerStep(dev, requested.planningPowerW, reported.planningPowerW)
    ? undefined
    : { stepId: requested.id, issuedAtMs };
}

/**
 * Whether the device's own reading already shows the lower step: its draw is
 * nearer the requested step than the reported one. The step landed and only
 * its report is missing (a Flow that applies the level but does not report it
 * back). Retiring the request would hide that: the card would show the device
 * running at the reported step with no word that its level change went
 * unconfirmed. Kept, the request lets the card point the owner at the Flow
 * that reports the level back.
 */
function drawShowsLowerStep(dev: PlanInputDevice, requestedW: number, reportedW: number): boolean {
  return isMeteredPlanDevice(dev) && dev.currentDrawKw * 1000 <= (requestedW + reportedW) / 2;
}

/**
 * Everything the builder needs about one device this cycle: the producer's
 * input device plus the per-cycle decisions the stages above it reached.
 */
export type BasePlanDeviceInputs = {
  dev: PlanInputDevice;
  recentlyRestored: boolean;
  binaryCommandPending: boolean;
  plannedTarget: number | undefined;
  shedBehavior: ShedBehavior;
  /**
   * This cycle's shedding decision, WHOLE — who is shed, why, and the rung each
   * stepped shed was priced at. The stage above holds this object already, so it
   * arrives as itself rather than as three of its members re-listed here.
   */
  sheddingPlan: SheddingPlan;
  fairnessLimited: boolean;
  boostActive: boolean;
  /** The existing surplus-posture predicate's decision, excluding fresh capacity reasons. */
  surplusHoldShed: boolean;
  surplusAbsorbActive: boolean;
  priceTargetShift: PriceTargetShift;
  /** A temperature override is in force (`DevicePlanDevice.temporaryTemperatureActive`). */
  temporaryTemperatureActive: boolean;
  modePreparation?: PreparedModeTarget;
  /**
   * The rung this cycle's surplus allocation bought a surplus-TRACKING device,
   * or undefined for every other device. A ceiling on the keep step, never a
   * target — see `resolveSteppedKeepDesiredStepId`.
   */
  surplusCeilingStepId: string | undefined;
};

function buildLastResortFields(inputs: BasePlanDeviceInputs): Pick<
  DevicePlanDevice, 'lastResort' | 'lastResortCommand' | 'lastResortOwnedOffAtMs'
> {
  const { dev, sheddingPlan } = inputs;
  if (!dev.lastResort) return {};
  return {
    lastResort: dev.lastResort,
    ...(sheddingPlan.lastResortCutIds?.has(dev.id) && isBinaryPlanDevice(dev) && dev.currentOn
      ? { lastResortCommand: 'off' as const } : {}),
    lastResortOwnedOffAtMs: sheddingPlan.lastResortOwnedOffAtMs?.get(dev.id),
  };
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function buildBasePlanDevice(inputs: BasePlanDeviceInputs): DevicePlanDevice {
  const { dev, binaryCommandPending, boostActive, surplusAbsorbActive, priceTargetShift } = inputs;
  const { currentState } = dev;
  const decision = resolvePlannedDeviceDecision(inputs);
  const {
    plannedState, effectiveDesiredStepId, shedDesiredStepId, baseReason,
    shedAction, shedTemperature, releaseShedStepId, plannedTarget: resolvedPlannedTarget,
  } = decision;
  // ONE object, filled in place. This used to be a literal fed by five helper
  // objects and seven conditional spreads: fourteen allocations per device per
  // build to produce one, and each spread re-grew the backing store on the way.
  // The three wrappers below key on key PRESENCE, so setting a cluster field
  // only when the device carries it says exactly what the spreads said —
  // `withTemperatureDiscriminant`/`withBinaryDiscriminant` regroup their
  // orthogonal clusters (binary keyed on the resolved `currentOn`) and
  // `withSteppedDiscriminant` lands the result in one stepped union member.
  const loose: LooseDevicePlanDevice = {
    id: dev.id,
    name: dev.name,
    isEvCharger: dev.isEvCharger,
    isBatteryOrSolar: dev.isBatteryOrSolar,
    phaseFootprint: dev.phaseFootprint,
    storageHold: { kind: 'none' },
    deviceType: dev.deviceType,
    currentState,
    plannedState,
    reportedStepId: dev.reportedStepId,
    desiredStepId: effectiveDesiredStepId,
    previousStepId: dev.previousStepId,
    lastDesiredStepId: dev.desiredStepId,
    lastStepCommandIssuedAt: dev.lastStepCommandIssuedAt,
    stepCommandRetryCount: dev.stepCommandRetryCount,
    nextStepCommandRetryAtMs: dev.nextStepCommandRetryAtMs,
    priority: dev.priority,
    expectedPowerKw: resolveExpectedPowerKw(dev, currentState, plannedState, effectiveDesiredStepId),
    expectedPowerSource: dev.expectedPowerSource,
    controlAdapter: dev.controlAdapter,
    ...(dev.binarySwitchGeneration !== undefined ? { binarySwitchGeneration: dev.binarySwitchGeneration } : {}),
    ...buildLastResortFields(inputs),
    // `commandableNow` MUST be carried. Dropping it is what forced consumers
    // back onto raw-field re-derivation against fields the plan device does not
    // have, so every plan-device `isCommandableNow` answered from absence and
    // reported "charger state unknown" for every EV charger.
    commandableNow: dev.commandableNow,
    hasStandingDemand: dev.hasStandingDemand,
    reason: baseReason,
    control: dev.control,
    budgetExempt: dev.budgetExempt,
    available: dev.available,
    boostActive,
    surplusAbsorbActive,
    priceTargetShift,
    stepCommandPending: dev.stepCommandPending,
    stepCommandStatus: dev.stepCommandStatus,
    binaryCommandPending,
    shedAction,
    shedTemperature,
    releaseShedStepId,
    residualKw: dev.residualKw,
    surplusTracking: dev.surplusTracking,
  };
  const relayShedDecision = inputs.sheddingPlan.relayShedDecisions?.get(dev.id);
  if (relayShedDecision !== undefined) loose.relayShedDecision = relayShedDecision;
  Object.assign(loose, resolveHoldDecisions(inputs, decision));
  // The power axis, only when the input device has a reading this cycle.
  Object.assign(loose, meteredCluster(dev));
  // The binary on/off truth, only when the input device is binary this cycle.
  // Forwarded unchanged — resolved once at `toPlanDevice`, never recomputed.
  if (isBinaryPlanDevice(dev)) loose.currentOn = dev.currentOn;
  Object.assign(loose, temperatureCluster(inputs, resolvedPlannedTarget));
  // Assign the stepped cluster as a unit. `SteppedLoadKind`
  // requires all three, so dropping one here is a local compile error rather
  // than a `planningPowerKw` that reads `undefined` inside the ladder pricing.
  if (isSteppedLoadDevice(dev)) {
    Object.assign(loose, {
      steppedLoadProfile: dev.steppedLoadProfile,
      selectedStepId: dev.selectedStepId,
      planningPowerKw: dev.planningPowerKw,
    } satisfies SteppedLoadKind);
  }
  // Decisions the PRODUCER already made (`toPlanDevice` -> `resolveCommandableNow`),
  // forwarded verbatim. Nothing below re-derives them: `commandableNow` and
  // `hasStandingDemand` are in the literal above for the same reason.
  if (dev.commandabilityReason) loose.commandabilityReason = dev.commandabilityReason;
  if (dev.objectiveKind) loose.objectiveKind = dev.objectiveKind;
  if (shedDesiredStepId !== undefined) loose.plannedShedStepId = shedDesiredStepId;
  // Propagated owner/producer facts, carried only when set so the plan device
  // says "absent" by omission the way the spread literals did.
  if (dev.surplusOnly === true) loose.surplusOnly = true;
  if (dev.externalOffHoldActive === true) loose.externalOffHoldActive = true;
  if (dev.heatingPauseActive === true) loose.heatingPauseActive = true;
  if (dev.targetPowerClaimNeeded === true) loose.targetPowerClaimNeeded = true;
  if (dev.reservesStartupPower === true) loose.reservesStartupPower = true;

  if (decision.stepDownToRetire) loose.stepDownToRetire = decision.stepDownToRetire;
  return withSteppedDiscriminant(withTemperatureDiscriminant(withBinaryDiscriminant(withMeteredDiscriminant(loose))));
}

/** Keep the required temperature fields together and add preparation only while it is active. */
function temperatureCluster(inputs: BasePlanDeviceInputs, plannedTarget: number | undefined) {
  const { dev, temporaryTemperatureActive, modePreparation } = inputs;
  if (!isTemperaturePlanDevice(dev)) return undefined;
  const temperature: TemperatureKind & Pick<LooseDevicePlanDevice, 'temporaryTemperatureActive' | 'modePreparation'> = {
    currentTarget: dev.currentTarget,
    currentTemperature: dev.currentTemperature,
    plannedTarget: plannedTarget ?? dev.currentTarget,
    temporaryTemperatureActive,
  };
  if (modePreparation !== undefined) temperature.modePreparation = modePreparation;
  return temperature;
}
/* eslint-enable functional/immutable-data */

// A helper rather than another conditional in the builder above (its
// complexity budget is nearly spent): the draw is forwarded unchanged, resolved once at
// `toPlanDevice`, and only for a device that has one.
/**
 * The holds that are not capacity pressure, DECIDED once here rather than carried
 * as settings, for the output-side readers that have only the plan.
 *
 * - `startPolicyHoldActive`: `getInactiveReason` and starvation eligibility ask
 *   whether the policy is holding this device, and only the shared predicate
 *   knows the smart-task lift.
 * - `chargeTargetHeld`: the same question for the charge target, answered with
 *   the held target so `getInactiveReason` can name it.
 * - `deferredHoldActive`: the device's own smart task holds it off, so
 *   `getInactiveReason` leaves its explanation to the task.
 * - `nonCapacityHoldShed`: this cycle's reduction is a standing hold or solar
 *   tracking alone, with no fresh capacity reason, for fairness and actuation clocks.
 *   `shedSet` membership is part of the question, not a hedge: a start-policy
 *   device that is already off is `inactive`, not shed.
 */
function resolveHoldDecisions(
  inputs: BasePlanDeviceInputs,
  decision: PlannedDeviceDecision,
): Pick<LooseDevicePlanDevice,
  'startPolicyHoldActive' | 'chargeTargetHeld' | 'carCurrentRangeHeld' | 'deferredHoldActive'
  | 'nonCapacityHoldShed' | 'waitingForTaskPlan'> {
  const { dev, sheddingPlan, surplusHoldShed } = inputs;
  const { shedSet, shedReasons } = sheddingPlan;
  // Keys only when true: absence is the one spelling of "not held".
  const holdOnly = (dev.heatingPauseActive === true && decision.plannedState === 'shed')
    || (shedSet.has(dev.id)
    && (isStartPolicyHoldShed(dev, shedReasons) || isChargeTargetHoldShed(dev, shedReasons)
      || isCarCurrentRangeHoldShed(dev, shedReasons)
      || isDeferredHoldShed(dev, shedReasons) || surplusHoldShed))
    || isSurplusCeilingReduction(inputs, decision);
  const chargeTargetHeld = resolveHeldChargeTarget(dev);
  return {
    ...(isStartPolicyHeldDevice(dev) ? { startPolicyHoldActive: true as const } : {}),
    ...(chargeTargetHeld ? { chargeTargetHeld } : {}),
    ...(isCarCurrentRangeHeldDevice(dev) ? { carCurrentRangeHeld: true as const } : {}),
    ...(dev.deferredHold !== undefined ? { deferredHoldActive: true as const } : {}),
    ...(holdOnly ? { nonCapacityHoldShed: true as const } : {}),
    ...(dev.waitingForTaskPlan ? { waitingForTaskPlan: true as const } : {}),
  };
}

function isSurplusCeilingReduction(inputs: BasePlanDeviceInputs, decision: PlannedDeviceDecision): boolean {
  const { dev, surplusCeilingStepId, boostActive, fairnessLimited, sheddingPlan } = inputs;
  return dev.surplusTracking
    && !boostActive
    && !fairnessLimited
    && decision.plannedState === 'keep'
    && !sheddingPlan.shedReasons.has(dev.id)
    && surplusCeilingStepId !== undefined
    && decision.effectiveDesiredStepId === surplusCeilingStepId
    && isSteppedLoadDevice(dev)
    && isSteppedLoadStepBelow(dev, surplusCeilingStepId, dev.selectedStepId);
}

function meteredCluster(dev: PlanInputDevice): MeteredDiscriminantProbe {
  return isMeteredPlanDevice(dev) ? { currentDrawKw: dev.currentDrawKw } : {};
}

/**
 * May PELS put this device somewhere other than where it is?
 *
 * Gated on `commandAuthority`, not on power limiting. Those were the same
 * boolean until the split, which is why a managed device with power limiting
 * off could not be planned off for ANY reason — the planner could not tell it
 * from a device it had been told to ignore.
 */
function resolvePlannedState(control: DeviceControlPosture, shouldShed: boolean): 'shed' | 'keep' {
  if (!control.commandAuthority) return 'keep';
  return shouldShed ? 'shed' : 'keep';
}
/** The start policy's own shed intent: off, not the owner's limiting floor. */
const TURN_OFF_SHED_BEHAVIOR: ShedBehavior = { action: 'turn_off' };

/**
 * The shed behaviour IN FORCE for this device this cycle.
 *
 * A start-policy hold is shed to OFF, not to the owner's power-limiting floor.
 * That floor answers "how far down when the house is short of power"; reusing it
 * here left a `set_step` charger parked at 6 A and a `set_temperature` thermostat
 * pinned at its setback, both still drawing, under a switch that promises PELS
 * turns the device off. A fresh capacity shed keeps the floor
 * (`isStartPolicyHoldShed` is false the moment `shedReasons` carries one).
 *
 * Resolved ONCE, at the top of the device build, because two stages read it and
 * they must not disagree: the rung selection that prices a stepped shed
 * (`resolveSteppedLoadDirectShedStepId`) and the action materialization below.
 * While the override lived here alone, rung selection had already answered from
 * the configured floor, and `resolvePlannedShedTargetKind` then read that active
 * rung as the decided end state.
 */
function resolveEffectiveShedBehavior(
  dev: PlanInputDevice,
  shouldShed: boolean,
  configured: ShedBehavior,
  shedReasons: Map<string, DeviceReason>,
): ShedBehavior {
  if (dev.lastResort || dev.heatingPauseActive) return TURN_OFF_SHED_BEHAVIOR;
  // A smart task's deferred-hour hold is shed to OFF for the same reason: the task
  // wants the device off, and the floor still draws (`isDeferredHoldShed`).
  //
  // Only for a device that CAN be turned off: an on/off handle or a step ladder. A
  // temperature-only device has neither, so an OFF there issues no command at all
  // and the plain setpoint write keeps it heating to its mode target under a plan
  // that says off. Its configured floor, the setback, is the most "off" it has.
  // A charger held at its target is shed to OFF whatever else sheds it: a
  // stepped charger at its lowest current keeps charging past the target, and a
  // capacity reason on the same cycle does not make that acceptable. So this
  // asks whether the hold applies (`isChargeTargetHeldDevice`), not whether it
  // is this cycle's only reason (`isChargeTargetHoldShed`, which still decides
  // whether the shed counts as capacity pressure).
  const heldOff = isStartPolicyHoldShed(dev, shedReasons) || isChargeTargetHeldDevice(dev)
    || isCarCurrentRangeHeldDevice(dev)
    || (dev.deferredHold === 'off' && isDeferredHoldShed(dev, shedReasons));
  const canTurnOff = isBinaryPlanDevice(dev) || isSteppedLoadDevice(dev);
  return shouldShed && heldOff && canTurnOff ? TURN_OFF_SHED_BEHAVIOR : configured;
}

function resolveShedAction(
  dev: PlanInputDevice,
  shouldShed: boolean,
  /** Already resolved by {@link resolveEffectiveShedBehavior} — never the raw configured floor. */
  shedBehavior: ShedBehavior,
): { shedAction: ShedAction; shedTemperature: number | null; releaseShedStepId: string | null } {
  // Single resolution site for the shed-action intent. Called once here with
  // the post-admission authority so the deferred-objective rescue lane
  // (`applyDeferredAdmissionToInput`) is honoured. The materialiser then only
  // gates on the per-cycle `shouldShed` decision (no producer equivalent).
  const intent = resolveShedIntent({
    shedBehavior,
    commandAuthority: dev.control.commandAuthority,
    hasBinaryControl: isBinaryPlanDevice(dev),
    steppedLoadProfile: isSteppedLoadDevice(dev) ? dev.steppedLoadProfile : undefined,
    primaryTarget: getPrimaryTargetCapability(dev.targets),
  });
  return materializeShedSnapshotFields({
    intent,
    shouldShed,
  });
}
