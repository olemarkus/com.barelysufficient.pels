import { resolveDeviceControlPosture, resolveStartPolicyInForce } from '../device/temperatureControlPosture';
import { resolveDeviceStartPolicy } from '../../packages/shared-domain/src/settings/deviceStartPolicy';
import { resolveObservedCurrentState } from '../observer/observedState';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveCanSetControl } from '../device/deviceActionProjection';
import type { BoostResolveInput } from '../device/deviceActionProjection';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import {
  buildResidualKwForPlanDevice,
} from './residualKwForPlanDevice';
import type {
  PlanInputDeviceProjectionFacts,
  PlanInputProjectionSource,
  ToPlanDeviceInput,
  ToPlanDeviceOptions,
} from './planInputDeviceTypes';
import {
  buildStepPowerCalibrationView,
  resolveConfirmedNotDrawing,
} from './calibrationViews';
import {
  resolveEffectiveShedBehavior,
  resolveEffectiveTemperatureBoost,
  resolvePlanBoostFields,
  resolvePlanCommandability,
  resolvePlanCommandabilityReason,
  resolvePlanObjective,
  resolveSteppedClusterFields,
  resolveSteppedLadderMissing,
  resolveSurplusPostureForDevice,
} from './planInputDeviceHelpers';
import { resolveEvTargetPowerPlannerProfile } from '../device/targetPowerReachability';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

/** Resolve configuration and observation into the facts used by plan input. */
export const resolvePlanInputDeviceFacts = (
  source: PlanInputProjectionSource,
  device: ToPlanDeviceInput,
  options: ToPlanDeviceOptions,
): PlanInputDeviceProjectionFacts => {
  const isSteppedDevice = isSteppedLoadSnapshot(device);
  const plannerSteppedLoadProfile = isSteppedDevice
    ? resolveEvTargetPowerPlannerProfile({
      config: source.getTargetPowerConfig(device.id) ?? device.targetPowerConfig,
      confirmedProfile: device.steppedLoadProfile,
      nowMs: source.getNow().getTime(),
    })
    : undefined;
  const steppedCluster = resolveSteppedClusterFields(plannerSteppedLoadProfile, device);
  const steppedLadderMissing = resolveSteppedLadderMissing(device, steppedCluster);
  const observedCurrentState = resolveObservedCurrentState(device);
  const powerCalibration = source.getPowerCalibrationSnapshot();
  const calibration = isSteppedDevice || device.isEvCharger
    ? buildStepPowerCalibrationView(powerCalibration, device)
    : undefined;
  const confirmedNotDrawing = typeof device.reportedStepId === 'string'
    ? resolveConfirmedNotDrawing(
      powerCalibration,
      source.getNow().getTime(),
      device,
      observedCurrentState === 'off',
    )
    : false;

  const physicallyCommandable = resolveCommandableNow(device);
  const commandability = resolvePlanCommandability(device, options, physicallyCommandable);
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
  const shedBehavior = resolveEffectiveShedBehavior(source, device);
  const temperatureBoost = resolveEffectiveTemperatureBoost(source, device);
  const evBoost = source.getEvBoostConfig(device.id);
  const startPolicy = resolveDeviceStartPolicy(source.getDeviceStartPolicies(), device.id);
  const capacityControlEnabled = source.isCapacityControlEnabled(device.id);
  const control = resolveDeviceControlPosture(
    device,
    source.resolveManagedState(device.id),
    capacityControlEnabled,
    startPolicy,
  );
  const startPolicyInForce = resolveStartPolicyInForce(startPolicy, capacityControlEnabled);
  const externalOffHoldActive = source.isExternalOffHoldActive(device.id, device);
  const hasStandingDemand = !isEvObserved(device);
  const { surplusOnly, surplusTracking } = resolveSurplusPostureForDevice(
    source,
    device,
    options,
    control,
  );
  const boostInput: BoostResolveInput = {
    commandableNow: physicallyCommandable,
    targets: device.targets,
    steppedLoadProfile: steppedCluster.steppedLoadProfile,
    ...(hasObservedStateOfCharge(device) ? { stateOfCharge: device.stateOfCharge } : {}),
    ...(device.temperature
      ? { currentTemperature: device.temperature.currentTemperature }
      : {}),
    ...(evBoost ? { evBoost } : {}),
    ...(temperatureBoost ? { temperatureBoost } : {}),
  };
  const residualKw = buildResidualKwForPlanDevice({
    device,
    hasBinaryControl: device.binaryControl !== undefined,
    shedBehavior,
  });

  return {
    steppedCluster,
    steppedLadderMissing,
    observedCurrentState,
    calibration,
    confirmedNotDrawing,
    commandableNow: commandability.commandableNow,
    commandabilityReason,
    objective,
    boost: resolvePlanBoostFields(boostInput),
    canSetControlResolved,
    startPolicy,
    control,
    startPolicyInForce,
    surplusOnly,
    surplusTracking,
    externalOffHoldActive,
    hasStandingDemand,
    residualKw,
    budgetExempt: source.isBudgetExempt(device.id),
  };
};
