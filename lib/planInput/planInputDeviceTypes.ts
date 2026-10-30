import type { ObservedCurrentStateInput } from '../observer/observedState';
import type {
  BinaryCommandabilityProjection,
  BinaryCommandabilityProjectionInput,
} from '../plan/admission/binaryCommandReachability';
import type { DeviceControlSettingsRead } from '../device/deviceControlSettings';
import type { PriceOptimizationSettings } from '../price/priceOptimizer';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import type { AssociatedCarDecoration } from '../../packages/contracts/src/types';
import type {
  PlanInputDeviceBase,
  StoragePlanInputKind,
} from '../../packages/planner-types/src/planInputDevice';
import type { StorageLaneBinding } from '../ports/batteryControlOwner';
import type { PlanInputSnapshotDevice } from './runtimeDeviceRead';
import type { ShedBehavior, SteppedClusterFields } from '../plan/planTypes';
import type { PlanInputDevice } from '../plan/planTypes';
import type { ContinuousBatteryPlanRead } from '../../packages/contracts/src/continuousBatteryPlan';

/** Required owner reads used by the planner-input projection. */
export type PlanInputProjectionSource = {
  getNow: () => Date;
  isWaitingForCarAssociation: (deviceId: string) => boolean;
  getPowerCalibrationSnapshot: () => PowerCalibrationSnapshot;
  /**
   * The owner's device-control settings: target-power, boost and charge-target
   * configs, start policies, budget exemptions, and the `controllable_devices`
   * map. A home battery's Power-limit control is read from that map through the
   * battery's own gate (`isBatteryPowerLimitEnabled`, `storageProjection.ts`),
   * never through `isCapacityControlEnabled`, which vetoes every battery.
   */
  deviceControl: DeviceControlSettingsRead;
  getPriceOptimizationSettings: (deviceId: string) => PriceOptimizationSettings | undefined;
  isSurplusPoolReachable: () => boolean;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  isCapacityControlEnabled: (deviceId: string) => boolean;
  readContinuousBatteryPlan: (deviceId: string) => ContinuousBatteryPlanRead;
  resolveManagedState: (deviceId: string) => boolean;
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

/**
 * The planner-input fields the projection resolves from owner reads, already in
 * the contract's own shape (optional flags present only when set), so
 * `assemblePlanInputDevice` lays them over the device rather than re-listing them.
 */
export type ResolvedPlanInputFacts = Pick<PlanInputDeviceBase,
  | 'currentState' | 'confirmedNotDrawing' | 'commandableNow' | 'commandabilityReason'
  | 'objectiveKind' | 'objectiveSessionInactive' | 'waitingForCarAssociation' | 'boostSupported' | 'boostRequested'
  | 'canSetControlResolved' | 'startPolicy' | 'control' | 'startPolicyInForce' | 'chargeTargetHold'
  | 'surplusOnly' | 'surplusTracking' | 'externalOffHoldActive' | 'steppedLadderMissing'
  | 'stepPowerCalibration' | 'hasStandingDemand' | 'residualKw' | 'budgetExempt'>
  & SteppedClusterFields
  // Not `StorageClusterFields`: its empty member is `Record<string, never>`,
  // which no object carrying the fields above can satisfy.
  & (StoragePlanInputKind | { storage?: never });
