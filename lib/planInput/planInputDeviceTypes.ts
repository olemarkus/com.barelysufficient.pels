import type { ObservedCurrentStateInput } from '../observer/observedState';
import type { DeviceStartPolicy } from '../../packages/shared-domain/src/settings/deviceStartPolicy';
import type {
  BinaryCommandabilityProjection,
  BinaryCommandabilityProjectionInput,
} from '../plan/admission/binaryCommandReachability';
import type { DeviceTargetPowerConfigsWithReachability } from '../device/targetPowerReachability';
import type { PriceOptimizationSettings } from '../price/priceOptimizer';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import type {
  AssociatedCarDecoration,
  EvBoostConfig,
  SteppedLoadDecoration,
  TemperatureBoostConfig,
} from '../../packages/contracts/src/types';
import type { DeviceControlPosture } from '../../packages/planner-types/src/planInputDevice';
import type { RuntimeDeviceRead } from './runtimeDeviceRead';
import type { ShedBehavior, SteppedClusterFields } from '../plan/planTypes';
import type { PlanInputDevice } from '../plan/planTypes';

/** Required owner reads used by the planner-input projection. */
export type PlanInputProjectionSource = {
  getNow: () => Date;
  getPowerCalibrationSnapshot: () => PowerCalibrationSnapshot;
  getTargetPowerConfig: (
    deviceId: string,
  ) => DeviceTargetPowerConfigsWithReachability[string] | undefined;
  getPriceOptimizationSettings: (deviceId: string) => PriceOptimizationSettings | undefined;
  isSurplusPoolReachable: () => boolean;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  getTemperatureBoostConfig: (deviceId: string) => TemperatureBoostConfig | undefined;
  getEvBoostConfig: (deviceId: string) => EvBoostConfig | undefined;
  getDeviceStartPolicies: () => Record<string, DeviceStartPolicy>;
  isCapacityControlEnabled: (deviceId: string) => boolean;
  resolveManagedState: (deviceId: string) => boolean;
  isBudgetExempt: (deviceId: string) => boolean;
  isExternalOffHoldActive: (deviceId: string, device: ObservedCurrentStateInput) => boolean;
};

/** Resolved main-home or capacity-only policy for one projection. */
export type ToPlanDeviceOptions = {
  surplusPostureEnabled: boolean;
  projectCommandability: (params: BinaryCommandabilityProjectionInput) => BinaryCommandabilityProjection;
};

export type ToPlanDeviceInput = RuntimeDeviceRead & SteppedLoadDecoration & AssociatedCarDecoration;
export type UnrankedPlanInputDevice = Omit<PlanInputDevice, 'priority'>;

/** Resolved facts shared by the plan-device assembly stages. */
export type PlanInputDeviceProjectionFacts = {
  steppedCluster: SteppedClusterFields;
  steppedLadderMissing: boolean;
  observedCurrentState: PlanInputDevice['currentState'];
  calibration: Record<string, number> | undefined;
  confirmedNotDrawing: boolean;
  commandableNow: boolean;
  commandabilityReason: PlanInputDevice['commandabilityReason'] | undefined;
  objective: Pick<PlanInputDevice, 'objectiveKind' | 'objectiveSessionInactive'>;
  boost: Pick<PlanInputDevice, 'boostSupported' | 'boostRequested'>;
  canSetControlResolved: boolean;
  startPolicy: DeviceStartPolicy;
  control: DeviceControlPosture;
  startPolicyInForce: PlanInputDevice['startPolicyInForce'];
  surplusOnly: boolean;
  surplusTracking: boolean;
  externalOffHoldActive: boolean;
  hasStandingDemand: boolean;
  residualKw: PlanInputDevice['residualKw'];
  budgetExempt: boolean;
};
