import type { DeviceControlPosture } from '../../packages/planner-types/src/planInputDevice';
import type {
  DevicePlanDevice, LooseDevicePlanDevice, PlanInputDevice, ShedAction, ShedBehavior,
  SteppedLoadKind, TemperatureKind,
} from './planTypes';
import {
  withBinaryDiscriminant, withSteppedDiscriminant, withTemperatureDiscriminant,
} from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { resolveShedIntent } from '../device/deviceActionProjection';
import { isStartPolicyHeldDevice, isStartPolicyHoldShed } from './shedding/startPolicyHold';
import { materializeShedSnapshotFields } from './planActionMaterialization';
import { resolveSteppedLoadDirectShedStepId } from './planSteppedShedResolution';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { getHighestKnownPowerKw } from '../observer/observedPower';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';
import {
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepIdFor,
  resolveSteppedLoadInitialDesiredStepId,
} from './planSteppedLoad';
import { isBinaryPlanDevice } from './planBinaryDevice';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';

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
  return getHighestKnownPowerKw(dev).kw;
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
  shedDesiredStepId: string | undefined;
  baseReason: DeviceReason;
  shedAction: ShedAction;
  shedTemperature: number | null;
  releaseShedStepId: string | null;
  plannedTarget: number | undefined;
};

function resolvePlannedDeviceDecision(inputs: BasePlanDeviceInputs): PlannedDeviceDecision {
  const {
    dev, recentlyRestored, control, shedSet, shedStepTargets, shedReasons,
    boostActive, surplusCeilingStepId,
  } = inputs;
  const shouldShed = shedSet.has(dev.id);
  // ONE effective shed behaviour for this DEVICE-BUILD stage, resolved before
  // either reader. (Other stages — the normalized-floor pass, restore candidate
  // pricing — still answer from the configured floor; none is reachable for a
  // held device today.) The start-policy override used to sit inside `resolveShedAction`,
  // below the rung selection that had already priced the shed from the owner's
  // CONFIGURED floor — so a `set_step` charger got its lowest active rung, the
  // materializer read that active rung as the decided end state, and the device
  // parked at 6 A under a switch promising PELS turns it off.
  const shedBehavior = resolveEffectiveShedBehavior(dev, shouldShed, inputs.shedBehavior, shedReasons);
  const runtimeDesiredStepId = dev.desiredStepId ?? resolveSteppedLoadInitialDesiredStepId(dev);
  const shedDesiredStepId = resolveSteppedLoadDirectShedStepId({
    dev,
    shedBehavior,
    shouldShed,
    plannedShedStepId: shedStepTargets.get(dev.id),
  });
  const isSteppedShed = isSteppedLoadDevice(dev)
    && shedDesiredStepId !== undefined
    && shedDesiredStepId !== dev.selectedStepId;
  const plannedState = resolvePlannedState(control, shouldShed || isSteppedShed);
  const { shedAction, shedTemperature, releaseShedStepId } = resolveShedAction({
    dev,
    control,
    shouldShed,
    shedBehavior,
  });
  return {
    plannedState,
    effectiveDesiredStepId: resolveSteppedKeepDesiredStepIdFor(
      dev, plannedState, shedDesiredStepId ?? runtimeDesiredStepId,
      inputs.anyOtherDeviceLimited, boostActive, surplusCeilingStepId,
    ),
    shedDesiredStepId,
    // Keyed on AUTHORITY, not on power limiting. `capacityControlOff` says "PELS is
    // not controlling this device" — false the moment a smart task has contributed
    // its authority term, and the old code agreed because the task used to write
    // `controllable: true` and this line read that same flag. Reading
    // the owner's raw toggle here instead made an impossible pair reachable: a device the
    // task authorised could be planned `shed` while still carrying
    // `capacity_control_off`, which `validatePlanReasonPair` rejects outright.
    baseReason: control.commandAuthority
      ? shedReasons.get(dev.id)
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

/**
 * Everything the builder needs about one device this cycle: the producer's
 * input device plus the per-cycle decisions the stages above it reached.
 */
export type BasePlanDeviceInputs = {
  dev: PlanInputDevice;
  priority: number;
  recentlyRestored: boolean;
  binaryCommandPending: boolean;
  currentState: string;
  plannedTarget: number | undefined;
  // The whole posture: this builder asks BOTH questions of it, and they have
  // different answers for a managed device with power limiting off.
  control: DeviceControlPosture;
  shedBehavior: ShedBehavior;
  shedSet: Set<string>;
  /** Per device, the rung the shedding planner priced this cycle's shed at. */
  shedStepTargets: Map<string, string>;
  anyOtherDeviceLimited: boolean;
  shedReasons: Map<string, DeviceReason>;
  boostActive: boolean;
  surplusAbsorbActive: boolean;
  /**
   * The rung this cycle's surplus allocation bought a surplus-TRACKING device,
   * or undefined for every other device. A ceiling on the keep step, never a
   * target — see `resolveSteppedKeepDesiredStepId`.
   */
  surplusCeilingStepId: string | undefined;
};

export function buildBasePlanDevice(inputs: BasePlanDeviceInputs): DevicePlanDevice {
  const {
    dev, priority, binaryCommandPending, currentState, control, boostActive, surplusAbsorbActive,
  } = inputs;
  const {
    plannedState, effectiveDesiredStepId, shedDesiredStepId, baseReason,
    shedAction, shedTemperature, releaseShedStepId, plannedTarget: resolvedPlannedTarget,
  } = resolvePlannedDeviceDecision(inputs);
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
    deviceClass: dev.deviceClass,
    deviceRole: dev.deviceRole,
    deviceType: dev.deviceType,
    currentState,
    plannedState,
    // Finalize decides (`finalizePlanDevices`); pre-finalize always false.
    recordRestoreOnTargetApply: false,
    reportedStepId: dev.reportedStepId,
    targetStepId: effectiveDesiredStepId,
    desiredStepId: effectiveDesiredStepId,
    previousStepId: dev.previousStepId,
    lastDesiredStepId: dev.desiredStepId,
    lastStepCommandIssuedAt: dev.lastStepCommandIssuedAt,
    stepCommandRetryCount: dev.stepCommandRetryCount,
    nextStepCommandRetryAtMs: dev.nextStepCommandRetryAtMs,
    priority,
    expectedPowerKw: resolveExpectedPowerKw(dev, currentState, plannedState, effectiveDesiredStepId),
    expectedPowerSource: dev.expectedPowerSource,
    currentDrawKw: dev.currentDrawKw,
    controlAdapter: dev.controlAdapter,
    // `commandableNow` MUST be carried. Dropping it is what forced consumers
    // back onto raw-field re-derivation against fields the plan device does not
    // have, so every plan-device `isCommandableNow` answered from absence and
    // reported "charger state unknown" for every EV charger.
    commandableNow: dev.commandableNow,
    hasStandingDemand: dev.hasStandingDemand,
    reason: baseReason,
    zone: dev.zone || 'Unknown',
    control,
    budgetExempt: dev.budgetExempt,
    available: dev.available,
    boostActive,
    surplusAbsorbActive,
    stepCommandPending: dev.stepCommandPending,
    stepCommandStatus: dev.stepCommandStatus,
    binaryCommandPending: binaryCommandPending || undefined,
    shedAction,
    shedTemperature,
    releaseShedStepId,
    residualKw: dev.residualKw,
    surplusTracking: dev.surplusTracking,
  };
  // The hold DECIDED once here, not the owner's setting carried through: the
  // two output-side readers (`getInactiveReason`, starvation eligibility) ask
  // whether the policy is holding this device, and only the shared predicate
  // knows the smart-task lift. See `DevicePlanDeviceBase.startPolicyHoldActive`.
  if (isStartPolicyHeldDevice(dev)) loose.startPolicyHoldActive = true;
  // The binary on/off truth, only when the input device is binary this cycle.
  // Forwarded unchanged — resolved once at `toPlanDevice`, never recomputed.
  if (isBinaryPlanDevice(dev)) loose.currentOn = dev.currentOn;
  // The temperature cluster as a UNIT, and the `satisfies` is the unit: the
  // three fields are independent optionals on `LooseDevicePlanDevice`, so
  // written one line at a time a dropped field compiles clean and the device
  // reads `undefined` behind a required `number` — the exact hole
  // `TemperatureClusterFields` exists to close. One literal per cluster per
  // device is the price of keeping that a compile error; the fourteen this
  // commit removes were per device too.
  if (isTemperaturePlanDevice(dev)) {
    Object.assign(loose, {
      currentTarget: dev.currentTarget,
      currentTemperature: dev.currentTemperature,
      // `?? dev.currentTarget` is the type-level seam for the totality
      // invariant, not a runtime state: "no commanded setpoint" materializes as
      // planned === current, which the executor's no-op fence skips.
      plannedTarget: resolvedPlannedTarget ?? dev.currentTarget,
    } satisfies TemperatureKind);
  }
  // The stepped cluster as a UNIT, for the reason above: `SteppedLoadKind`
  // requires all three, so dropping one here is a local compile error rather
  // than a `planningPowerKw` that reads `undefined` inside the ladder pricing.
  if (isSteppedLoadDevice(dev)) {
    Object.assign(loose, {
      steppedLoadProfile: dev.steppedLoadProfile,
      selectedStepId: dev.selectedStepId,
      planningPowerKw: dev.planningPowerKw,
    } satisfies SteppedLoadKind);
  }
  // BUDGET SPENT: the eleven conditionals below and above, plus the three
  // logical operators in the literal, put this function at exactly the
  // `complexity` ceiling of 15 (`eslint.config.mjs`, warnings are errors). A
  // twelfth conditional field needs a helper, not another `if` — that is what
  // the five deleted `pick*` helpers were buying, at fourteen objects a device.
  // Decisions the PRODUCER already made (`toPlanDevice` -> `resolveCommandableNow`),
  // forwarded verbatim. Nothing below re-derives them: `commandableNow` and
  // `hasStandingDemand` are in the literal above for the same reason.
  if (dev.commandabilityReason) loose.commandabilityReason = dev.commandabilityReason;
  if (dev.objectiveKind) loose.objectiveKind = dev.objectiveKind;
  if (shedDesiredStepId !== undefined) loose.plannedShedStepId = shedDesiredStepId;
  // Propagated owner/producer facts, carried only when set so the plan device
  // says "absent" by omission the way the spread literals did.
  if (dev.stepPowerCalibration) loose.stepPowerCalibration = dev.stepPowerCalibration;
  if (dev.surplusOnly === true) loose.surplusOnly = true;
  if (dev.externalOffHoldActive === true) loose.externalOffHoldActive = true;
  if (dev.reservesStartupPower === true) loose.reservesStartupPower = true;

  return withSteppedDiscriminant(withTemperatureDiscriminant(withBinaryDiscriminant(loose)));
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
  return shouldShed && isStartPolicyHoldShed(dev, shedReasons) ? TURN_OFF_SHED_BEHAVIOR : configured;
}

function resolveShedAction(params: {
  dev: PlanInputDevice;
  control: DeviceControlPosture;
  shouldShed: boolean;
  /** Already resolved by {@link resolveEffectiveShedBehavior} — never the raw configured floor. */
  shedBehavior: ShedBehavior;
}): { shedAction: ShedAction; shedTemperature: number | null; releaseShedStepId: string | null } {
  const {
    dev, control, shouldShed, shedBehavior,
  } = params;
  // Single resolution site for the shed-action intent. Called once here with
  // the post-admission authority so the deferred-objective rescue lane
  // (`applyDeferredAdmissionToInput`) is honoured. The materialiser then only
  // gates on the per-cycle `shouldShed` decision (no producer equivalent).
  const intent = resolveShedIntent({
    shedBehavior,
    commandAuthority: control.commandAuthority,
    hasBinaryControl: isBinaryPlanDevice(dev),
    steppedLoadProfile: isSteppedLoadDevice(dev) ? dev.steppedLoadProfile : undefined,
    primaryTarget: getPrimaryTargetCapability(dev.targets),
  });
  return materializeShedSnapshotFields({
    intent,
    shouldShed,
  });
}
