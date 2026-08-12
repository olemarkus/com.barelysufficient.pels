import type {
  EvChargingState,
  BinaryControlCapabilityId,
  DeviceControlModel,
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
 * boundary (AGENTS.md: accept duplication when consolidation would cross a
 * layering boundary). `stepPowerCalibration` carries both calibrated views the
 * controller reads: delivery power sizes objective energy, while admission
 * power reserves physical capacity. The planner's richer
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
  // The observed `evcharger_charging_state` capability, produced by the transport
  // parser (`lib/device/transport/managerParseDeviceFields.ts`) and forwarded
  // unchanged on the `PlanInputDevice` that reaches this layer. Present for every
  // EV charger — the parser requires the capability of every `evcharger` and a
  // member of the Homey enum for its value, dropping the device otherwise — and
  // absent for everything else, which is why it is optional on this contract.
  // A partial `device.update` that omits the capability retains the previous
  // valid observation; only a device with no valid observation at all is dropped.
  // Read through `isEvObserved` + the shared `isEvSessionInactive` /
  // `isEvChargerNotResumable` classifiers — never by re-inlining plug-state
  // literals. The flat `evSessionInactive` / `evChargerNotResumable` bits this
  // replaced were producer-materialized duplicates of exactly this value.
  evChargingState?: EvChargingState;
  // Producer-resolved "Leave off until turned on again" posture: the user turned
  // the device off outside PELS and asked PELS to respect that. Structurally
  // assignable from `PlanInputDevice`, which carries the same flat bit.
  externalOffHoldActive?: true;
  /**
   * The CONFIGURED control model, structurally assignable from `PlanInputDevice`.
   * NOTHING in this module reads it: the step-ladder gap it used to be inferred
   * from is now resolved by the producer and carried as `steppedLadderMissing`
   * below. Declared only while `PlanInputDevice` still carries the field, and
   * retired with it.
   */
  controlModel?: DeviceControlModel;
  /**
   * Producer-resolved step-ladder gap, structurally assignable from
   * `PlanInputDevice`: `true` when the device is configured as a stepped load but
   * no live ladder resolved this cycle. The smart-task stack must tell that apart
   * from "never stepped" — a stepped device without its ladder has no rate to
   * plan against, so `resolveObjectiveSteps` answers "no steps" and
   * `resolvePlanningSpeedKw` answers "no speed", and a COMMITTED task is served
   * its frozen plan instead of collapsing to `unknown`.
   */
  steppedLadderMissing?: true;
  /**
   * Producer-resolved draw when running, structurally assignable from
   * `PlanInputDevice`. Required, like it is there: `estimatePower` ends its
   * ladder on a default, so a smart task never has to invent a rate for a
   * device nobody described.
   */
  expectedPowerKw: number;
  planningPowerKw?: number;
  /**
   * Producer-resolved current draw, structurally assignable from
   * `PlanInputDevice`. Required, like it is there: the raw `measuredPowerKw`
   * does not travel past the producer, so there is nothing here to be absent.
   */
  currentDrawKw: number;
  currentTemperature?: number;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
  lastFreshDataMs?: number;
  stepPowerCalibration?: Record<string, { admissionPowerKw: number; deliveryPowerKw: number }>;
};
