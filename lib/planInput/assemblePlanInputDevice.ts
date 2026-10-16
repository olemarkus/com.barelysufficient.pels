import { resolvePlanPowerAxis } from '../observer/observedPower';
import { resolveCurrentOn } from '../observer/observedState';
import { resolveTemperatureInputFields } from './planInputDeviceHelpers';
import type {
  ResolvedPlanInputFacts,
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
    // Read by the shed-behaviour producer from the runtime device; the planner
    // receives the resolved shed behaviour, never the floor it came from.
    setpointShedFloorC: _setpointShedFloorC,
    // A home battery's signed power and claim value reach the plan only as the
    // resolved storage cluster below; its level reaches only the overview card.
    batteryPower: _batteryPower,
    batteryClaim: _batteryClaim,
    batteryLevel: _batteryLevel,
    ...deviceFields
  } = device;
  return deviceFields;
};

/** Assemble producer-resolved facts as the structurally complete planner contract. */
export const assemblePlanInputDevice = (
  rawDevice: ToPlanDeviceInput,
  device: ToPlanDeviceInput,
  facts: ResolvedPlanInputFacts,
): UnrankedPlanInputDevice => withSteppedDiscriminant({
  ...withoutNonPlanInputFields(device),
  ...facts,
  targetPowerConfig: withoutTargetPowerReachability(device.targetPowerConfig),
  ...(device.binaryControl !== undefined ? { currentOn: resolveCurrentOn(device) } : {}),
  ...resolvePlanPowerAxis(rawDevice),
  ...resolveTemperatureInputFields(device),
});
