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

type AllKeys<T> = T extends unknown ? keyof T : never;

/**
 * Fields of the runtime read that reach planner input although the planner
 * contract does not declare them. Each is either planner input the contract
 * should declare, or a field to strip below. Do not add to this list.
 */
type UndeclaredPlanInputField =
  | 'associatedCar' | 'binaryControllable' | 'canSetControl' | 'capabilities' | 'controllable'
  | 'evCharging' | 'evChargingObservedAtMs' | 'evChargingStateObservedAtMs' | 'lastFreshDataMs'
  | 'lastUpdated' | 'managed' | 'measuredPowerObservedAtMs' | 'planningPowerKw' | 'powerCapable'
  | 'priority' | 'reportedStepObservedAtMs' | 'reportedStepPowerW' | 'selectedStepId' | 'stateOfCharge';

type UnclassifiedField<T> = Exclude<AllKeys<T>, AllKeys<UnrankedPlanInputDevice> | UndeclaredPlanInputField>;

/**
 * Compiles only when every field left on the device is planner input or is
 * listed in `UndeclaredPlanInputField`, so a new runtime field cannot reach the
 * planner unnoticed: declare it in the planner contract or strip it.
 */
const classified = <T extends object>(
  fields: T & ([UnclassifiedField<T>] extends [never] ? unknown : { unclassifiedField: UnclassifiedField<T> }),
): T => fields;

const withoutNonPlanInputFields = (device: ToPlanDeviceInput) => {
  const {
    temperatureControlDisabled: _temperatureControlDisabled,
    temperatureAdjustmentsDisabled: _temperatureAdjustmentsDisabled,
    steppedLoadProfile: _confirmedSteppedLoadProfile,
    targetPowerConfig: _targetPowerConfig,
    carCurrentRangeUnavailable: _carCurrentRangeUnavailable,
    measuredPowerKw: _measuredPowerKw,
    measuredPowerIsDirectMeasurement: _measuredPowerIsDirectMeasurement,
    // Read once by the footprint producer; the planner receives the footprint.
    chargerPhaseCurrentsA: _chargerPhaseCurrentsA,
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
    // The production-cap lane has its own planner input and never controls a load.
    inverterControl: _inverterControl,
    inverterObservation: _inverterObservation,
    // Identification metadata stays with the device; planning uses the resolved waiting fact.
    carConfirmation: _carConfirmation,
    // The device's echo of its accepted step settles the executor's command
    // session; the planner reads the resolved `stepCommandStatus` instead.
    acknowledgedStep: _acknowledgedStep,
    ...deviceFields
  } = device;
  return classified(deviceFields);
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
