import {
  hasStandingCommandGrant, resolveDeviceControlPosture, resolveStartPolicyInForce,
} from '../device/temperatureControlPosture';
import { resolveDeviceStartPolicy, type DeviceStartPolicy }
  from '../../packages/shared-domain/src/settings/deviceStartPolicy';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { resolveObservedCurrentState } from '../observer/observedState';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveCanSetControl } from '../device/deviceActionProjection';
import type { BoostResolveInput } from '../device/deviceActionProjection';
import { isEvDevice, resolveEvChargeAction } from '../../packages/shared-domain/src/evPlugState';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import {
  buildResidualKwForPlanDevice,
} from './residualKwForPlanDevice';
import type {
  PlanInputProjectionSource,
  ResolvedPlanInputFacts,
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
import { resolveStorageCluster } from './storageProjection';
import { resolvePhaseFootprint } from '../phaseFootprint/resolvePhaseFootprint';
import { resolveOperatingChargingPhases } from '../phaseFootprint/chargingPhaseFootprints';
import { projectChargeTargetHold } from './chargeTargetHold';
import {
  getSteppedLoadLowestActiveStep, hasUsableSteppedLoadLadder, isSteppedLoadStepOff,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { SteppedClusterFields } from '../plan/planTypes';

/**
 * The owner's standing grants for a device, read from the same settings the
 * facts below resolve its posture from. Needs no device facts, so it answers
 * for a device the plan input does not carry yet (one with no power reading).
 */
export const resolveStandingCommandGrant = (
  source: PlanInputProjectionSource,
  deviceId: string,
): boolean => hasStandingCommandGrant(
  source.resolveManagedState(deviceId),
  source.isCapacityControlEnabled(deviceId),
  resolveDeviceStartPolicy(source.deviceControl.deviceStartPolicies, deviceId),
);

/** The contract's present-only-when-set postures: the key is the whole of "set". */
const resolvePresenceFlags = (
  steppedLadderMissing: boolean,
  surplusOnly: boolean,
  externalOffHoldActive: boolean,
): Pick<ResolvedPlanInputFacts, 'steppedLadderMissing' | 'surplusOnly' | 'externalOffHoldActive'> => ({
  ...(steppedLadderMissing ? { steppedLadderMissing: true as const } : {}),
  ...(surplusOnly ? { surplusOnly: true as const } : {}),
  ...(externalOffHoldActive ? { externalOffHoldActive: true as const } : {}),
});

/**
 * The ladder PELS plans a charger on while its car has finished the session
 * (`offer`, `resolveEvChargeAction`): its off step and its lowest charging
 * step. PELS keeps that current on offer for when the car asks again, and never
 * raises it. A higher step offers a car that takes nothing more current, and
 * queues ahead of a charger whose car is charging; the switch-on write sends
 * the same minimum (`lib/device/easee/switch.ts`). The full ladder returns with
 * the next session state.
 */
const resolveFinishedSessionProfile = (
  device: ToPlanDeviceInput,
  profile: SteppedLoadProfile,
): SteppedLoadProfile => {
  if (!isEvObserved(device) || resolveEvChargeAction(device.evChargingState) !== 'offer') return profile;
  const lowest = getSteppedLoadLowestActiveStep(profile);
  if (lowest === null) return profile;
  return { ...profile, steps: profile.steps.filter((step) => isSteppedLoadStepOff(step) || step.id === lowest.id) };
};

/**
 * Whether a managed device's watt target is Homey's to claim. The plan claims
 * it in the cycles PELS may command the device (`buildExecutableDeviceIntent`).
 */
const resolveTargetPowerClaim = (
  source: PlanInputProjectionSource, device: ToPlanDeviceInput, managed: boolean,
): Pick<ResolvedPlanInputFacts, 'targetPowerClaimNeeded'> => (
  managed && device.available !== false && source.getTargetPowerControlClaim(device.id) === 'needed'
    ? { targetPowerClaimNeeded: true as const } : {}
);

/** Resolve the command ladder and an incompatible car range together at the input boundary. */
const resolveSteppedPlanInputFields = (
  source: PlanInputProjectionSource,
  device: ToPlanDeviceInput,
): SteppedClusterFields & Pick<ResolvedPlanInputFacts, 'carCurrentRangeUnavailable'> => {
  const isSteppedDevice = isSteppedLoadSnapshot(device);
  const limitedSteppedLoadProfile = isSteppedDevice
    ? resolveEvTargetPowerPlannerProfile({
      config: device.targetPowerConfig?.preset
        ? { ...source.deviceControl.getDeviceTargetPowerConfig(device.id), ...device.targetPowerConfig }
        : device.targetPowerConfig,
      confirmedProfile: device.steppedLoadProfile,
      nowMs: source.getNow().getTime(),
    })
    : undefined;
  const carCurrentRangeUnavailable = device.carCurrentRangeUnavailable === true
    || (device.targetPowerConfig?.currentLimits !== undefined
      && !hasUsableSteppedLoadLadder(limitedSteppedLoadProfile));
  // An impossible car/charger range is a forced-off policy, not a missing
  // control channel. Retain the real usable ladder so the pause can execute.
  const plannerSteppedLoadProfile = carCurrentRangeUnavailable && isSteppedDevice
    ? device.steppedLoadProfile
    : limitedSteppedLoadProfile && (device.chargingInstallationLoad
      ? limitedSteppedLoadProfile : resolveFinishedSessionProfile(device, limitedSteppedLoadProfile));
  return {
    ...resolveSteppedClusterFields(plannerSteppedLoadProfile, device),
    ...(carCurrentRangeUnavailable ? { carCurrentRangeUnavailable: true as const } : {}),
  };
};

/** Resolve configuration and observation into the facts used by plan input. */
function resolveLastResortSetup(source: PlanInputProjectionSource, device: ToPlanDeviceInput) {
  const maximumW = source.deviceControl.lastResortDevices?.[device.id];
  if (maximumW === undefined || device.temperature !== undefined || device.isBatteryOrSolar
    || isEvDevice(device) || isSteppedLoadSnapshot(device)) return undefined;
  const observation = device.binaryControlObservation;
  return {
    maximumW,
    ...(hasObservedMeasuredPower(device) ? { metered: true as const } : {}),
    ...(observation?.observedValue === false ? { observedOffAtMs: observation.observedAtMs } : {}),
  };
}

// A reading that appears while the relay is off cannot strand PELS's own OFF:
// the restore still reserves the full maximum. A running relay with a reading
// is no longer an unmetered relay, so PELS leaves it alone.
function resolveLastResortControl(managed: boolean, source: PlanInputProjectionSource, device: ToPlanDeviceInput) {
  const observation = device.binaryControlObservation;
  return {
    managed,
    commandAuthority: managed && device.canSetControl === true && observation !== undefined
      && device.binaryControl?.on === observation.observedValue
      && (observation.observedValue === false || !hasObservedMeasuredPower(device))
      && !source.deviceControl.devicePowerSources?.[device.id],
  };
}

function resolvePlanControlPolicy(
  source: PlanInputProjectionSource, device: ToPlanDeviceInput, capacityControlEnabled: boolean,
  lastResort: boolean, startPolicy: DeviceStartPolicy,
) {
  const managed = source.resolveManagedState(device.id);
  return lastResort ? {
    control: resolveLastResortControl(managed, source, device),
    startPolicyInForce: 'unrestricted' as const,
    budgetExempt: false,
  } : {
    control: resolveDeviceControlPosture(device, managed, capacityControlEnabled, startPolicy),
    startPolicyInForce: resolveStartPolicyInForce(startPolicy, capacityControlEnabled),
    budgetExempt: source.deviceControl.isBudgetExempt(device.id),
  };
}

function canCommandPhysicalDevice(device: ToPlanDeviceInput): boolean {
  const installationCarFinished = device.controlAdapter?.chargingInstallation !== undefined
    && isEvObserved(device) && resolveEvChargeAction(device.evChargingState) === 'offer';
  return !installationCarFinished && resolveCommandableNow(device);
}

export const resolvePlanInputDeviceFacts = (
  source: PlanInputProjectionSource,
  device: ToPlanDeviceInput,
  options: ToPlanDeviceOptions,
): ResolvedPlanInputFacts => {
  const isSteppedDevice = isSteppedLoadSnapshot(device);
  const steppedCluster = resolveSteppedPlanInputFields(source, device);
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

  const physicallyCommandable = canCommandPhysicalDevice(device);
  const commandability = resolvePlanCommandability(device, options, physicallyCommandable);
  const commandabilityReason = commandability.reason !== 'none'
    ? commandability.reason
    : resolvePlanCommandabilityReason(device);
  const objective = resolvePlanObjective(device);
  const canSetControlResolved = resolveCanSetControl({
    binaryControl: device.binaryControl,
    capabilities: device.capabilities,
    canSetControl: device.canSetControl,
  });
  const shedBehavior = resolveEffectiveShedBehavior(source, device);
  const temperatureBoost = resolveEffectiveTemperatureBoost(source, device);
  const evBoost = source.deviceControl.getEvBoostConfig(device.id);
  const startPolicy = resolveDeviceStartPolicy(source.deviceControl.deviceStartPolicies, device.id);
  const capacityControlEnabled = source.isCapacityControlEnabled(device.id);
  const lastResort = resolveLastResortSetup(source, device);
  const { control, startPolicyInForce, budgetExempt } = resolvePlanControlPolicy(
    source, device, capacityControlEnabled, lastResort !== undefined, startPolicy,
  );
  const externalOffHoldActive = source.isExternalOffHoldActive(device.id, device);
  const hasStandingDemand = !isEvDevice(device);
  const { surplusOnly, surplusTracking } = lastResort ? { surplusOnly: false, surplusTracking: false }
    : resolveSurplusPostureForDevice(
    source,
    device,
    options,
    control,
    hasStandingDemand,
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
    ...steppedCluster,
    ...resolvePresenceFlags(resolveSteppedLadderMissing(device, steppedCluster), surplusOnly, externalOffHoldActive),
    currentState: observedCurrentState,
    ...(lastResort ? { lastResort } : {}),
    ...(calibration ? { stepPowerCalibration: calibration } : {}),
    confirmedNotDrawing,
    commandableNow: commandability.commandableNow,
    ...(commandabilityReason ? { commandabilityReason } : {}),
    ...objective,
    waitingForCarAssociation: source.isWaitingForCarAssociation(device.id),
    ...resolveTargetPowerClaim(source, device, control.managed),
    ...resolvePlanBoostFields(boostInput),
    canSetControlResolved,
    startPolicy,
    control,
    startPolicyInForce,
    chargeTargetHold: projectChargeTargetHold(source.deviceControl.getEvChargeTargetConfig(device.id), device, control),
    surplusTracking,
    hasStandingDemand,
    residualKw,
    budgetExempt,
    phaseFootprint: resolvePhaseFootprint({
      ownerConnection: source.deviceControl.getDevicePhaseConnection(device.id),
      isEvCharger: device.isEvCharger,
      chargerPhaseCurrentsA: device.chargerPhaseCurrentsA,
      evPreset: device.targetPowerConfig?.preset,
      learned: source.getLearnedPhaseFootprint(device.id),
      operatingPhases: device.isEvCharger ? resolveOperatingChargingPhases(device.steppedLoadProfile) : undefined,
    }),
    ...resolveStorageCluster(source, device, options),
  };
};
