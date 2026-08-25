import type {
  DevicePlanDevice, PlanInputDevice, ShedAction, ShedBehavior, SteppedClusterFields, TemperatureClusterFields,
} from './planTypes';
import {
  withBinaryDiscriminant, withSteppedDiscriminant, withTemperatureDiscriminant,
} from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { resolveShedIntent } from '../device/deviceActionProjection';
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
  resolveSteppedKeepDesiredStepId,
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
  const steppedExpectedPowerKw = resolveSteppedExpectedPowerKw({
    dev,
    currentState,
    plannedState,
    effectiveDesiredStepId,
  });
  if (steppedExpectedPowerKw !== null) return steppedExpectedPowerKw;
  return getHighestKnownPowerKw(dev).kw;
}
function resolveSteppedExpectedPowerKw(params: {
  dev: PlanInputDevice;
  currentState: string;
  plannedState: 'shed' | 'keep';
  effectiveDesiredStepId: string | undefined;
}): number | null {
  const {
    dev,
    currentState,
    plannedState,
    effectiveDesiredStepId,
  } = params;
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
// The temperature cluster, taken as a unit through the guard (twin of
// `pickSteppedPlanFields`). The input kind guarantees `currentTarget` and
// `currentTemperature` after narrowing (the observer's atomic facet); the
// planner's own `plannedTarget` is resolved for every temperature device
// (`resolvePlannedTarget` is total on the temperature branch), so the trio is
// complete by construction. `withTemperatureDiscriminant` re-ties the cluster
// onto the temperature variant.
function pickTemperatureClusterFields(
  dev: PlanInputDevice,
  resolvedPlannedTarget: number | undefined,
): TemperatureClusterFields {
  if (!isTemperaturePlanDevice(dev)) return {};
  return {
    currentTarget: dev.currentTarget,
    currentTemperature: dev.currentTemperature,
    // `?? dev.currentTarget` is the type-level seam for the totality invariant
    // above, not a runtime state: "no commanded setpoint" materializes as
    // planned === current, which the executor's no-op fence skips.
    plannedTarget: resolvedPlannedTarget ?? dev.currentTarget,
  };
}

// Source the binary on/off truth only when the input device is binary this cycle;
// `withBinaryDiscriminant` keys the cluster on that resolved `currentOn`. The
// value is forwarded from the input device unchanged — it is resolved once at
// `toPlanDevice`, not recomputed.
function resolveInputBinaryControlField(
  dev: PlanInputDevice,
): { currentOn?: boolean } {
  return isBinaryPlanDevice(dev) ? { currentOn: dev.currentOn } : {};
}

/**
 * The decisions the producer (`toPlanDevice` → `resolveCommandableNow`) already
 * made, forwarded verbatim onto the output plan device.
 *
 * `commandableNow` MUST be carried. Dropping it is what forced consumers back
 * onto raw-field re-derivation against fields the plan device does not have, so
 * every plan-device `isCommandableNow` answered from absence and reported
 * "charger state unknown" for every EV charger.
 */
function producerResolvedDecisionFields(dev: PlanInputDevice): {
  commandableNow: boolean;
  commandabilityReason?: PlanInputDevice['commandabilityReason'];
  objectiveKind?: PlanInputDevice['objectiveKind'];
  hasStandingDemand: boolean;
} {
  return {
    commandableNow: dev.commandableNow,
    hasStandingDemand: dev.hasStandingDemand,
    ...(dev.commandabilityReason ? { commandabilityReason: dev.commandabilityReason } : {}),
    ...(dev.objectiveKind ? { objectiveKind: dev.objectiveKind } : {}),
  };
}

export function buildBasePlanDevice(params: {
  dev: PlanInputDevice;
  priority: number;
  recentlyRestored: boolean;
  binaryCommandPending: boolean;
  currentState: string;
  plannedTarget: number | undefined;
  controllable: boolean;
  shedBehavior: ShedBehavior;
  shedSet: Set<string>;
  /** Per device, the rung the shedding planner priced this cycle's shed at. */
  shedStepTargets: Map<string, string>;
  anyOtherDeviceLimited: boolean;
  shedReasons: Map<string, DeviceReason>;
  boostActive: boolean;
  surplusAbsorbActive: boolean;
}): DevicePlanDevice {
  const {
    dev,
    priority,
    recentlyRestored,
    binaryCommandPending,
    currentState,
    plannedTarget,
    controllable,
    shedBehavior,
    shedSet,
    shedStepTargets,
    shedReasons,
    boostActive,
    surplusAbsorbActive,
  } = params;
  const initialDesiredStepId = resolveSteppedLoadInitialDesiredStepId(dev);
  const runtimeDesiredStepId = dev.desiredStepId ?? initialDesiredStepId;
  const directShedStepId = resolveSteppedLoadDirectShedStepId({
    dev,
    shedBehavior,
    shouldShed: shedSet.has(dev.id),
    plannedShedStepId: shedStepTargets.get(dev.id),
  });
  const shedDesiredStepId = directShedStepId;
  const desiredStepId = shedDesiredStepId ?? runtimeDesiredStepId;
  const isSteppedShed = isSteppedLoadDevice(dev)
    && shedDesiredStepId !== undefined
    && shedDesiredStepId !== dev.selectedStepId;
  const plannedState = resolvePlannedState(controllable, shedSet.has(dev.id) || isSteppedShed);
  const effectiveDesiredStepId = resolveSteppedKeepDesiredStepId({
    ...dev,
    currentState,
    plannedState,
    desiredStepId,
  }, {
    anyOtherDeviceLimited: params.anyOtherDeviceLimited,
    boostActive,
  });
  const baseReason: DeviceReason = controllable
    ? shedReasons.get(dev.id) ?? { code: PLAN_REASON_CODES.keep, detail: recentlyRestored ? 'recently restored' : null }
    : { code: PLAN_REASON_CODES.capacityControlOff };
  const { shedAction, shedTemperature, releaseShedStepId } = resolveShedAction({
    dev,
    controllable,
    shouldShed: shedSet.has(dev.id),
    shedBehavior,
  });
  const resolvedPlannedTarget = shedAction === 'set_temperature' && shedTemperature !== null
    ? shedTemperature
    : plannedTarget;
  // The stepped, temperature, and binary discriminants are set explicitly in
  // the loose literal, then re-tied: `withTemperatureDiscriminant`/
  // `withBinaryDiscriminant` regroup their orthogonal clusters (binary keyed on
  // `binaryCapabilityId` presence) and `withSteppedDiscriminant` lands the result
  // in one stepped union member. The temperature cluster is sourced as a unit
  // from the input device through `pickTemperatureClusterFields`.
  return withSteppedDiscriminant(withTemperatureDiscriminant(withBinaryDiscriminant({
    id: dev.id,
    name: dev.name,
    deviceClass: dev.deviceClass,
    deviceType: dev.deviceType,
    ...resolveInputBinaryControlField(dev),
    currentState,
    plannedState,
    // Finalize decides (`finalizePlanDevices`); pre-finalize always false.
    recordRestoreOnTargetApply: false,
    ...pickTemperatureClusterFields(dev, resolvedPlannedTarget),
    communicationModel: dev.communicationModel,
    ...pickSteppedPlanFields(dev),
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
    ...producerResolvedDecisionFields(dev),
    reason: baseReason,
    zone: dev.zone || 'Unknown',
    controllable,
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
    ...(shedDesiredStepId !== undefined ? { plannedShedStepId: shedDesiredStepId } : {}),
    ...pickPropagatedPlanFields(dev),
  })));
}

// The stepped cluster, taken as a unit through the guard. Extracted rather than
// tested inline per field: `steppedLoadProfile` and `planningPowerKw` both live
// on `SteppedLoadKind`, so one narrowing answers both, and keeping the branch
// out of `buildBasePlanDevice` keeps that function under the complexity ceiling.
// `withSteppedDiscriminant` re-ties the cluster into one variant.
function pickSteppedPlanFields(
  dev: PlanInputDevice,
): SteppedClusterFields {
  if (!isSteppedLoadDevice(dev)) return {};
  return {
    steppedLoadProfile: dev.steppedLoadProfile,
    selectedStepId: dev.selectedStepId,
    planningPowerKw: dev.planningPowerKw,
  };
}

function pickPropagatedPlanFields(
  dev: Pick<
    PlanInputDevice,
    'stepPowerCalibration' | 'residualKw' | 'surplusOnly'
    | 'externalOffHoldActive' | 'reservesStartupPower'
  >,
): Partial<Pick<
  DevicePlanDevice,
  'stepPowerCalibration' | 'surplusOnly'
  | 'externalOffHoldActive' | 'reservesStartupPower'
>> & Pick<DevicePlanDevice, 'residualKw'> {
  return {
    ...(dev.stepPowerCalibration ? { stepPowerCalibration: dev.stepPowerCalibration } : {}),
    residualKw: dev.residualKw,
    ...(dev.surplusOnly === true ? { surplusOnly: true as const } : {}),
    ...(dev.externalOffHoldActive === true ? { externalOffHoldActive: true as const } : {}),
    ...(dev.reservesStartupPower === true ? { reservesStartupPower: true as const } : {}),
  };
}

function resolvePlannedState(controllable: boolean, shouldShed: boolean): 'shed' | 'keep' {
  if (!controllable) return 'keep';
  return shouldShed ? 'shed' : 'keep';
}
function resolveShedAction(params: {
  dev: PlanInputDevice;
  controllable: boolean;
  shouldShed: boolean;
  shedBehavior: ShedBehavior;
}): { shedAction: ShedAction; shedTemperature: number | null; releaseShedStepId: string | null } {
  const { dev, controllable, shouldShed, shedBehavior } = params;
  // Single resolution site for the shed-action intent. Called once here with
  // the post-admission `controllable` so the deferred-objective rescue lane
  // (`applyDeferredAdmissionToInput`) is honoured. The materialiser then only
  // gates on the per-cycle `shouldShed` decision (no producer equivalent).
  const intent = resolveShedIntent({
    shedBehavior,
    controllable,
    hasBinaryControl: isBinaryPlanDevice(dev),
    steppedLoadProfile: isSteppedLoadDevice(dev) ? dev.steppedLoadProfile : undefined,
    primaryTarget: getPrimaryTargetCapability(dev.targets),
  });
  return materializeShedSnapshotFields({
    intent,
    shouldShed,
  });
}
