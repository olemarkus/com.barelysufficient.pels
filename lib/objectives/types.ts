import type {
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
 * **That width-subtyping is load-bearing AND a trap, so every field here must be
 * one the producer resolves.** There is no adapter to fail: when a field this
 * type declares as optional stops being emitted upstream, the assignment still
 * compiles and the field reads `undefined` forever. That is exactly how the
 * `evChargingState` read died silently once `toPlanDevice` began stripping the
 * raw plug-state — tsc saw a satisfied contract while an unplugged charger went
 * a whole night reported as a stale reading. Prefer a producer-resolved answer
 * (`objectiveSessionInactive`, `steppedLadderMissing`, `externalOffHoldActive`) over a raw
 * observed value, and never widen this type on the strength of a comment
 * upstream: check the producer.
 *
 * Kept deliberately separate from `PlanInputDevice` per the architecture
 * boundary (AGENTS.md: accept duplication when consolidation would cross a
 * layering boundary). `stepPowerCalibration` carries the one calibrated figure
 * per step that the controller reads — it sizes objective energy and reserves
 * physical capacity from the same number, because the store learns only one.
 *
 * See notes/state-management/deferred-objective-lifecycle-carveout.md.
 */
export type ObjectiveDeviceInput = {
  id: string;
  name: string;
  // Both are read only through the shared kind predicates — `isEvDevice` and
  // `isTemperatureControlDevice` (`objectiveSteps` / `planningSpeed`) — never by
  // comparing the strings here. Optional because they are optional on
  // `PlanInputDevice`; tightening either would break the structural assignment.
  deviceClass?: string;
  deviceType?: 'temperature' | 'onoff';
  steppedLoadProfile?: SteppedLoadProfile;
  priority?: number;
  /**
   * Producer-resolved "there is no creditable session to make progress in",
   * structurally assignable from `PlanInputDevice`. A plain boolean carrying no
   * reason code and no device-kind vocabulary, so this layer never asks what a
   * plug is — see the twin docblock on `PlanInputDevice` for why it is this
   * question and not `commandableNow`.
   *
   * REQUIRED, and that is the point. It replaced a read of `evChargingState`,
   * which this type declared as optional and documented as "forwarded unchanged
   * on the `PlanInputDevice` that reaches this layer". That was false —
   * `toPlanDevice` strips the raw plug-state — and because `PlanInputDevice` is
   * assigned here structurally, the stripped optional field simply read
   * `undefined` forever instead of failing to compile. The branch was dead and
   * an unplugged charger reported `objective_progress_stale` for whole task
   * windows. Every field here must be one the producer resolves, and one whose
   * absence tsc would catch.
   */
  objectiveSessionInactive: boolean;
  // Producer-resolved "Leave off until turned on again" posture: the user turned
  // the device off outside PELS and asked PELS to respect that. Structurally
  // assignable from `PlanInputDevice`, which carries the same flat bit.
  externalOffHoldActive?: true;
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
  stepPowerCalibration?: Record<string, number>;
};
