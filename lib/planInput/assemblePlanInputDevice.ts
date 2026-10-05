import { resolvePlanPowerAxis } from '../observer/observedPower';
import { resolveCurrentOn } from '../observer/observedState';
import { resolveTemperatureInputFields } from './planInputDeviceHelpers';
import type {
  PlanInputDeviceProjectionFacts,
  ToPlanDeviceInput,
  UnrankedPlanInputDevice,
} from './planInputDeviceTypes';
import { withSteppedDiscriminant } from '../plan/planTypes';
import { withoutTargetPowerReachability } from '../device/targetPowerReachability';

const withoutNonPlanInputFields = (device: ToPlanDeviceInput) => {
  const {
    temperatureControlDisabled: _temperatureControlDisabled,
    temperatureAdjustmentsDisabled: _temperatureAdjustmentsDisabled,
    steppedLoadProfile: _confirmedSteppedLoadProfile,
    targetPowerConfig: _targetPowerConfig,
    measuredPowerKw: _measuredPowerKw,
    measuredPowerIsDirectMeasurement: _measuredPowerIsDirectMeasurement,
    binaryControl: _binaryControl,
    binaryControlObservation: _binaryControlObservation,
    evChargingState: _evChargingState,
    temperature: _temperature,
    thermostatMode: _thermostatMode,
    // A home battery's signed power and claim value are observations nothing
    // plans on yet; the battery itself is observe-only.
    batteryPower: _batteryPower,
    batteryClaim: _batteryClaim,
    ...deviceFields
  } = device;
  return deviceFields;
};

/** Assemble producer-resolved facts as the structurally complete planner contract. */
export const assemblePlanInputDevice = (
  rawDevice: ToPlanDeviceInput,
  device: ToPlanDeviceInput,
  facts: PlanInputDeviceProjectionFacts,
): UnrankedPlanInputDevice => {
  const deviceFields = withoutNonPlanInputFields(device);
  return withSteppedDiscriminant({
    ...deviceFields,
    ...facts.steppedCluster,
    targetPowerConfig: withoutTargetPowerReachability(device.targetPowerConfig),
    targetStepId: device.targetStepId,
    desiredStepId: device.desiredStepId,
    previousStepId: device.previousStepId,
    lastStepCommandIssuedAt: device.lastStepCommandIssuedAt,
    stepCommandRetryCount: device.stepCommandRetryCount,
    nextStepCommandRetryAtMs: device.nextStepCommandRetryAtMs,
    stepCommandPending: device.stepCommandPending,
    stepCommandStatus: device.stepCommandStatus,
    currentState: facts.observedCurrentState,
    ...(device.binaryControl !== undefined ? { currentOn: resolveCurrentOn(device) } : {}),
    control: facts.control,
    startPolicy: facts.startPolicy,
    startPolicyInForce: facts.startPolicyInForce,
    available: device.available,
    ...(facts.surplusOnly ? { surplusOnly: true as const } : {}),
    surplusTracking: facts.surplusTracking,
    ...(facts.externalOffHoldActive ? { externalOffHoldActive: true as const } : {}),
    ...(facts.steppedLadderMissing ? { steppedLadderMissing: true as const } : {}),
    budgetExempt: facts.budgetExempt,
    ...facts.boost,
    commandableNow: facts.commandableNow,
    hasStandingDemand: facts.hasStandingDemand,
    ...(facts.commandabilityReason ? { commandabilityReason: facts.commandabilityReason } : {}),
    ...facts.objective,
    canSetControlResolved: facts.canSetControlResolved,
    residualKw: facts.residualKw,
    ...resolvePlanPowerAxis(rawDevice),
    ...resolveTemperatureInputFields(device),
    ...(facts.calibration ? { stepPowerCalibration: facts.calibration } : {}),
    confirmedNotDrawing: facts.confirmedNotDrawing,
  });
};
