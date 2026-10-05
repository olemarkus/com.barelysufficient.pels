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
  TemperatureBoostConfig,
} from '../../packages/contracts/src/types';
import type {
  DeviceControlPosture,
  StoragePlanInputKind,
} from '../../packages/planner-types/src/planInputDevice';
import type { StorageLaneBinding } from '../ports/batteryControlOwner';
import type { PlanInputSnapshotDevice } from './runtimeDeviceRead';
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

/** A home battery's storage cluster, or none: "no cluster" is the whole of "no lever". */
export type StorageClusterFields = StoragePlanInputKind | Record<string, never>;

/** Resolved main-home or capacity-only policy for one projection. */
export type ToPlanDeviceOptions = {
  surplusPostureEnabled: boolean;
  /** Home-battery control is Main only: a meter area projects no storage lever. */
  storage: StorageLaneBinding;
  projectCommandability: (params: BinaryCommandabilityProjectionInput) => BinaryCommandabilityProjection;
};

/** Planner input as served (`PlanInputSnapshotDevice`), plus the associated car the producer decorates on. */
export type ToPlanDeviceInput = PlanInputSnapshotDevice & AssociatedCarDecoration;
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
  storageCluster: StorageClusterFields;
};
