import type {
  BinaryControlCapabilityId,
  DeviceStateOfChargeSnapshot,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';

export type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
  ObjectiveProfileBand,
  ObjectiveProfileConfidence,
  ObjectiveProfileSampleObservation,
  ObjectiveProfileStat,
} from '../../packages/contracts/src/objectiveProfileTypes';

/**
 * Narrow device-data contract the smart-task controller reads to compute
 * lifecycle (progress, hours-remaining, feasibility, step power). It is the
 * subset of the planner's `PlanInputDevice` the controller actually consumes,
 * declared independently so the controller does not import `lib/plan` — the
 * precondition for relocating it out of the planner into a leafward peer
 * (`no-objectives-to-peer-except-power`). `PlanInputDevice` stays structurally
 * assignable to this by width-subtyping, so the planner passes its device list
 * straight through with no runtime adapter.
 *
 * Kept deliberately separate from `PlanInputDevice` per the architecture
 * boundary (CLAUDE.md: accept duplication when consolidation would cross a
 * layering boundary). `stepPowerCalibration` is narrowed to the one field the
 * controller reads (`deliveryPowerKw`); the planner's richer
 * `StepPowerCalibrationView` value type remains assignable.
 *
 * See notes/state-management/deferred-objective-lifecycle-carveout.md.
 */
export type ObjectiveDeviceInput = {
  id: string;
  name: string;
  deviceClass?: string;
  deviceType?: 'temperature' | 'onoff';
  // Carried so the canonical `isEvDevice` identity (deviceClass OR the
  // evcharger_charging capability) is type-visible here, matching the runtime
  // `PlanInputDevice` that flows in. The EV power-fallbacks in objectiveSteps /
  // planningSpeed rely on it.
  controlCapabilityId?: BinaryControlCapabilityId;
  steppedLoadProfile?: SteppedLoadProfile;
  priority?: number;
  // Producer-resolved EV plug-state decisions (the observer owns the raw
  // `evChargingState`); read via the shared `isEvSessionInactiveForDevice` /
  // `isEvChargerNotResumableForDevice` dual-read resolvers.
  evSessionInactive?: boolean;
  evChargerNotResumable?: boolean;
  powerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  measuredPowerKw?: number;
  currentTemperature?: number;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
  lastFreshDataMs?: number;
  stepPowerCalibration?: Record<string, { deliveryPowerKw: number }>;
};
