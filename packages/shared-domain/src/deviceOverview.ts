import type {
  ObservedStateOfCharge,
  EvChargingState,
  SteppedLoadProfile,
} from '../../contracts/src/types.js';
import type { DeviceReason } from './planReasonSemantics';
import type { PlannedTemperatureState } from './plannedTemperatureState';

/**
 * The stepped-control cluster, present IFF the device is stepped-controlled —
 * the overview shape's stepped discriminant, and the ONLY place a stepped fact
 * lives on this shape.
 *
 * It replaced a `controlModel: 'temperature_target' | 'binary_power' |
 * 'stepped_load'` setting that every consumer here only ever asked one question
 * of (`=== 'stepped_load'`), and that both carriers had to RECONSTRUCT because
 * the planner does not carry it — with different ladders, which is how the same
 * device came to render as a binary card on one surface and sign as stepped on
 * the other. `scripts/check-control-model-vocab.mjs` stated the rule: "stepped
 * load" is a yes/no CAPABILITY = presence of a valid ladder; `controlModel` is
 * a producer-only SETTING.
 *
 * The snapshot used to carry flat `reportedStepId` / `targetStepId` /
 * `selectedStepId` / `desiredStepId` / `steppedLoadProfile` BESIDE this,
 * copied raw off the plan device. That was not merely duplication: the two
 * disagreed. `buildOverviewSteppedLoad` corrects `targetStepId` when the
 * planner aims at a rung the confirmed ladder lacks (`plannerOnlyTarget`),
 * while the flat copy kept the uncorrected id, so two readers of the same
 * device answered differently.
 *
 * `selectedStepId` and `planningPowerKw` are REQUIRED here for the same reason
 * they are required on the planner's `SteppedLoadKind`: the producer chain
 * guarantees both for every stepped device (usable-ladder admission ⇒ a lowest
 * active step ⇒ an effective step and a planning power always resolve).
 */
export type DeviceOverviewSteppedLoad = {
  profile: SteppedLoadProfile;
  reportedStepId: string | null;
  targetStepId: string | null;
  /** Producer-resolved effective step. Required — see the docblock above. */
  selectedStepId: string;
  /** The draw the selected step is expected to pull. Required, as above. */
  planningPowerKw: number;
  commandPending: boolean;
};

export type DeviceOverviewSnapshot = {
  currentState?: string;
  plannedState?: string;
  /**
   * Present iff this device is stepped-controlled — the discriminant, and the
   * producer's own answer rather than a reconstruction. Absent means "no step
   * ladder", which is the only thing the retired `controlModel` was ever asked
   * here.
   */
  steppedLoad?: DeviceOverviewSteppedLoad;
  /**
   * NO `deviceType` here, deliberately. It used to ride this shape as the
   * temperature discriminant; the atomic `temperature` facet below replaced it,
   * because the facet is what actually carries the numbers a card renders. The
   * field then survived as a producer-only write with no reader on this shape —
   * a ghost the index-signature removal on `SettingsUiPlanDeviceSnapshot`
   * surfaced. Dropped rather than documented.
   *
   * `deviceType` is alive and correct on the *device-list* shape
   * (`SettingsUiDeviceListItem`, read by `deviceUtils.supportsTemperatureDevice`),
   * where the question is what the device IS — a capability — rather than which
   * numbers to display. Do not re-add it here to answer that question; the two
   * surfaces ask different ones.
   */
  binaryControllable: boolean;
  /** Producer-resolved: the planner's `isEvCharger`, forwarded, never re-derived. */
  isEvCharger: boolean;
  evChargingState?: EvChargingState;
  /**
   * The PRODUCER-RESOLVED current draw, never the raw `measure_power`
   * observation. Present IFF the device has a real power reading this cycle —
   * the plan device's power axis (`MeteredPlanInputKind`, `packages/planner-types`).
   * ABSENT for a device the plan runs without one (a temperature device that
   * gets mode and price setpoints but has nothing measuring its draw): that is
   * genuine domain absence, and it is never filled with `0`, which would label a
   * device nobody measured as drawing nothing.
   *
   * It was once an OPTIONAL `measuredPowerKw` that carriers forgot to populate,
   * which read as `0 kW` and labelled a drawing device "Idle". The name is now
   * the producer's, and every carrier forwards the plan device's field as is —
   * absent only where the plan device has no power axis.
   */
  currentDrawKw?: number;
  /**
   * Draw when running, REQUIRED — the producer's answer for every device, from
   * a rung ladder that ends in a device-class default, so there is no device it
   * has no figure for (`lib/device/devicePowerEstimate.ts`). Required on
   * `PlanInputDevice` and `DevicePlanDevice` already; it was optional only here,
   * on the seam furthest from the producer.
   */
  expectedPowerKw: number;
  reason: DeviceReason;
  /**
   * Producer-resolved: whether PELS manages this device. REQUIRED — the plan
   * producer resolves the owner's setting to a boolean once (`toPlanDevice`)
   * and every plan device carries the answer.
   * Optional here meant three states on the wire for a two-state fact, and
   * every consumer re-derived the same `!== false` collapse for itself.
   */
  controllable: boolean;
  /**
   * Producer-resolved reachability, REQUIRED for the same reason as
   * `controllable`: absence is not a third state, and the collapse belongs at
   * the producer rather than repeated at each reader. Read it as "not known to
   * be unavailable" — the transport resolves an unreadable value optimistically
   * to `true` (see the twin docblock on `DevicePlanDevice`).
   */
  available: boolean;
  shedAction?: 'turn_off' | 'set_temperature' | 'set_step';
  shedTemperature?: number | null;
  /**
   * The temperature facet, as ONE atomic optional object: present iff the
   * device is temperature-observed, and complete when present (the producer's
   * atomic facet + total planner resolution; the WebView adapter validates the
   * trio once at `parsePlanSnapshot` and drops a junk facet wholly). There are
   * no flat nullable temperature fields left on this shape — absence of the
   * facet is the one genuine "not a temperature device" state.
   */
  temperature?: PlannedTemperatureState;
  // Truthy while a target write is in flight — a satisfied verdict against the
  // pre-command setpoint would be premature.
  pendingTargetCommand?: unknown;
  // No flat step ids and no flat profile: they live on `steppedLoad` above,
  // which is the discriminant AND the single source for every stepped fact.
  // `steppedLoadProfile` in particular was a ghost here — the producer never
  // wrote it, yet `planCardReasonLine` read it with a fallback.
  binaryCommandPending?: boolean;
  // Drives the "Raised to use your solar power" reason line; included in the overview
  // transition signature so a flip (true→false) re-renders the card even when the
  // normalized plannedTarget is unchanged.
  surplusAbsorbActive?: boolean;
  stateOfCharge?: ObservedStateOfCharge;
};

/** The message fields of one device activity-log entry (`SettingsUiDeviceLogEntry`). */
export type DeviceOverviewStrings = {
  powerMsg: string | null;
  stateMsg: string;
  usageMsg: string;
  statusMsg: string;
};
