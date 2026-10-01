import type { DeferredObjectiveSettingsKind } from '../../packages/contracts/src/deferredObjectiveSettings';
import type {
  ObservedStateOfCharge,
  SteppedLoadProfile,
  ThermalDirection,
} from '../../packages/contracts/src/types';
import type { ObjectiveProfileProgressDirection } from '../../packages/contracts/src/objectiveProfileTypes';

export type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
  ObjectiveProfileBand,
  ObjectiveProfileConfidence,
  ObjectiveProfileSampleObservation,
  ObjectiveProfileStat,
} from '../../packages/contracts/src/objectiveProfileTypes';

export type ObjectiveProgressDirection = ObjectiveProfileProgressDirection;
export type ObjectiveProgressDirectionRead = ObjectiveProgressDirection | 'unknown';

// A battery level and an amount of energy delivered only ever rise; only a
// temperature can be driven down (a cooling thermostat).
export const resolveObjectiveProgressDirection = (params: {
  objectiveKind: DeferredObjectiveSettingsKind;
  thermalDirection: ThermalDirection;
}): ObjectiveProgressDirection => (
  params.objectiveKind !== 'temperature' || params.thermalDirection === 'heating'
    ? 'increasing'
    : 'decreasing'
);

export const resolveObjectiveProgressDirectionRead = (params: {
  objectiveKind: DeferredObjectiveSettingsKind;
  thermalDirection: ThermalDirection | 'unknown';
}): ObjectiveProgressDirectionRead => {
  if (params.objectiveKind !== 'temperature') return 'increasing';
  if (params.thermalDirection === 'unknown') return 'unknown';
  return resolveObjectiveProgressDirection({
    objectiveKind: params.objectiveKind,
    thermalDirection: params.thermalDirection,
  });
};

/**
 * Narrow device-data contract the smart-task controller reads to compute
 * lifecycle (progress, hours-remaining, feasibility, step power). It is the
 * subset of planner device data the controller actually consumes, declared
 * independently so the controller does not import `lib/plan` — the precondition
 * for relocating it out of the planner into a leafward peer
 * (`no-objectives-to-peer-except-power`). The objective boundary selects devices
 * with a power reading and attaches the observer-resolved thermal direction;
 * source devices therefore do not satisfy this contract by width-subtyping.
 *
 * **The boundary projection is load-bearing: every required field must be
 * resolved there, and every forwarded field must survive its source contract.**
 * An optional source field can still be stripped without a type error and then
 * read as `undefined` forever. That is exactly how the `evChargingState` read
 * died silently once `toPlanDevice` began stripping the raw plug-state — tsc
 * saw a satisfied contract while an unplugged charger went a whole night
 * reported as a stale reading. Prefer a producer-resolved answer
 * (`objectiveSessionInactive`, `steppedLadderMissing`, `externalOffHoldActive`)
 * over a raw observed value, and never widen this type on the strength of a
 * comment upstream: check the producer.
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
  // `isTemperatureControlDevice` (`objectiveSteps` / `planningSpeed`). Required,
  // as on `PlanInputDevice`: when the EV identity was an optional class it went
  // missing from planner input and nothing noticed.
  isEvCharger: boolean;
  deviceType: 'temperature' | 'onoff';
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
  /** Observer-resolved direction of temperature demand, attached at the objective boundary. */
  thermalDirection: ThermalDirection;
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
   * Producer-resolved current draw, structurally assignable from the plan
   * input's power axis (`MeteredPlanInputKind`). Required: a smart task plans
   * energy, so only a device with a power reading is an objective device —
   * `selectObjectiveDevices` below is where a plan's devices are narrowed to it.
   */
  currentDrawKw: number;
  currentTemperature?: number;
  // The RESOLVED level, not the transport's working state. This layer reads only
  // `level.kind`/`percent`; declaring the whole bag let it reach `report` and the
  // session bookkeeping it has no business with, and made a transport-internal
  // change look like an objectives-layer change.
  stateOfCharge?: ObjectiveStateOfCharge;
  // No observation timestamp anywhere on this input. Freshness and trust are
  // settled at the observer; the progress resolvers ask value questions only,
  // and every time question in this layer is asked on its own clock.
  stepPowerCalibration?: Record<string, number>;
};

/**
 * The observer's resolved charge level without its report time: smart tasks
 * never see observation timestamps. `ObservedStateOfCharge` is assignable to it.
 */
export type ObjectiveStateOfCharge = {
  level:
    | { kind: 'known'; percent: number; carChargeLimitPercent?: number }
    | Extract<ObservedStateOfCharge['level'], { kind: 'unavailable' }>;
};

/** Planner device data before metering and observer direction are resolved. */
export type ObjectiveDeviceSource = Omit<ObjectiveDeviceInput, 'currentDrawKw' | 'thermalDirection'>;

/**
 * The devices a smart task can plan for: those with a power reading. A
 * temperature device planned without one still gets its mode and price
 * setpoints from the planner, but there is no measured draw to plan energy
 * against, so it is not an objective device.
 *
 * The predicate duplicates `isMeteredPlanDevice` (`lib/plan/planMeteredDevice.ts`)
 * because this layer may not import `lib/plan` (`no-objectives-to-peer-except-power`
 * in `.dependency-cruiser.cjs`). Both key on the presence of the producer-resolved
 * `currentDrawKw`, so they cannot disagree.
 */
export const selectObjectiveDevices = <T extends ObjectiveDeviceSource>(
  devices: readonly T[],
): Array<T & Pick<ObjectiveDeviceInput, 'currentDrawKw'>> => (
  devices.filter((device): device is T & Pick<ObjectiveDeviceInput, 'currentDrawKw'> => (
    'currentDrawKw' in device && typeof device.currentDrawKw === 'number'
  ))
);

/** Add the observer's resolved temperature-demand direction to metered inputs. */
export const resolveObjectiveDeviceInputs = <T extends ObjectiveDeviceSource>(
  devices: readonly T[],
  getThermalDirection: (deviceId: string) => ThermalDirection,
): Array<T & Pick<ObjectiveDeviceInput, 'currentDrawKw' | 'thermalDirection'>> => (
  selectObjectiveDevices(devices).map((device) => ({
    ...device,
    thermalDirection: getThermalDirection(device.id),
  }))
);
