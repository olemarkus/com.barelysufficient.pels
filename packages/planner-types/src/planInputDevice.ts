import type {
  DeviceControlAdapterSnapshot,
  DeviceControlModel,
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  RestorePowerSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TargetCapabilitySnapshot,
  TargetPowerSteppedLoadConfig,
  TemperatureBoostConfig,
} from '../../contracts/src/types.js';

/**
 * The planner's primary INPUT contract: one device as the plan engine sees it
 * at the start of a cycle. Lives in `@pels/planner-types` (below the domain
 * peer layer, alongside `@pels/contracts`) so producer modules outside
 * `lib/plan` — notably the smart-task controller in `lib/objectives` — can
 * import and decorate it downward without inverting the peer DAG.
 *
 * `lib/plan/planTypes.ts` re-exports this symbol, so the ~54 existing consumers
 * that import `PlanInputDevice` from there keep working unchanged.
 */
/**
 * Stepped-control discriminant for the plan-input union (slice 2 of the
 * discriminated-types refactor). The stepped variant pins
 * `controlModel: 'stepped_load'` and requires the profile; the non-stepped
 * variant omits the profile entirely and excludes the stepped control model.
 * Moving `steppedLoadProfile` off the base makes the compiler reject
 * un-narrowed `device.steppedLoadProfile` reads — consumers must pass through
 * `isSteppedLoadDevice` first.
 *
 * The runtime guard lives in `lib/plan/planSteppedLoad.ts`; the kind helper
 * `SteppedLoadKind` in `lib/plan/planTypes.ts` mirrors this stepped shape.
 */
type SteppedPlanInputKind = {
  controlModel: 'stepped_load';
  steppedLoadProfile: SteppedLoadProfile;
};

type NonSteppedPlanInputKind = {
  // Omits `steppedLoadProfile` entirely (not `?: never`) so an un-narrowed read
  // on the union is a hard compile error rather than a silently-permitted
  // `SteppedLoadProfile | undefined`.
  controlModel?: Exclude<DeviceControlModel, 'stepped_load'>;
};

/**
 * EV field cluster for the plan-input contract (EV-variant slice). EV is
 * ORTHOGONAL to the stepped axis (an EV charger can also be stepped), so this
 * is NOT a union member; it is the intersection the `isEvPlanDevice` type-guard
 * (`lib/plan/planEvDevice.ts`) adds onto whichever stepped variant the device
 * is. The fields are OMITTED from `PlanInputDeviceBase`, so an un-narrowed read
 * is a hard compile error; every field is optional because the producer does
 * not guarantee any of them (snapshot-sourced `evChargingState` is absent on a
 * genuine EV cold start; `evBoost`/`stateOfCharge` only when configured/
 * reported). The plan-input side has no `evBoostActive` (resolved only on the
 * output `DevicePlanDevice`).
 */
export type EvPlanInputKind = {
  evChargingState?: string;
  evBoost?: EvBoostConfig;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
};

export type PlanInputDevice =
  | (PlanInputDeviceBase & SteppedPlanInputKind)
  | (PlanInputDeviceBase & NonSteppedPlanInputKind);

export type PlanInputDeviceBase = {
  id: string;
  name: string;
  targets: TargetCapabilitySnapshot[];
  deviceClass?: string;
  deviceType?: 'temperature' | 'onoff';
  observationStale?: boolean;
  communicationModel?: 'local' | 'cloud';
  reportedStepId?: string;
  targetStepId?: string;
  // Producer-resolved EFFECTIVE step (`reportedStepId` ?? planning fallback).
  // The retired raw-evidence trio (actualStepId / assumedStepId /
  // actualStepSource) collapsed into this plus the typed stepped-state adapter.
  selectedStepId?: string;
  desiredStepId?: string;
  previousStepId?: string;
  lastStepCommandIssuedAt?: number;
  stepCommandRetryCount?: number;
  nextStepCommandRetryAtMs?: number;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  controlAdapter?: DeviceControlAdapterSnapshot;
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
  priority?: number;
  /**
   * Producer-resolved bit (chunk 2 of the planner-detype refactor): true when
   * the device is commandable in this cycle, false when physically blocked
   * (EV unplugged/discharging, snapshot `available === false`, etc.). Optional
   * for the duration of the dual-read transition; chunk 6 makes it required.
   * Consumers MUST go through `lib/device/deviceActionProjection.isCommandableNow`
   * (or the boost equivalent) so the dual-read fallback applies uniformly.
   */
  commandableNow?: boolean;
  /** Opaque diagnostic string; UI / diagnostics consumers only. */
  commandableNowReason?: string | null;
  /**
   * Producer-resolved sibling bit (chunk 6 of the planner-detype refactor):
   * true when the device's binary control capability can be written this
   * cycle (`canSetControl !== false`, plus the legacy `canSetOnOff` fallback
   * for the `onoff` capability). Consumers MUST go through
   * `lib/device/deviceActionProjection.isCanSetControl` so the dual-read
   * fallback applies to raw-snapshot call sites uniformly.
   */
  canSetControlResolved?: boolean;
  /**
   * Producer-resolved aggregate boost flag (chunk 2): true if either the
   * temperature-boost or EV-boost policy is active this cycle.
   */
  boostActive?: boolean;
  /**
   * Producer-resolved residual-kW projection (chunks 3-4 of the planner-
   * detype refactor).
   *
   * - `shed` (chunk 3): the observable kW the configured shed behavior would
   *   remove if applied right now (post-kind-switch). Consumers in
   *   `lib/plan/planRemainingSheddableLoad.ts` read this directly after the
   *   flat plan-cycle gates instead of branching on the device's
   *   discriminated-union kind.
   * - `restore` (chunk 4): the kW the consumer would add by restoring this
   *   device. Collapses the `isSteppedLoadDevice + getSteppedLoadRestoreStep`
   *   chain in `lib/plan/restore/accounting.ts` into a single `{ kw, source }`
   *   pair. The `source` label preserves the legacy debug-log vocabulary
   *   (`'measured' | 'expected' | 'planning' | 'configured' | 'stepped' |
   *   'fallback'`). The producer keeps the stepped-vs-binary asymmetry
   *   intact: stepped+on uses live `planningPowerKw` (source `'planning'`),
   *   stepped+off uses the lowest-active step from the profile (source
   *   `'stepped'`), everything else falls back to the observer's
   *   `getRestoreDrawKw` (sources `'measured'` / `'expected'` / `'planning'`
   *   / `'configured'` / `'fallback'`).
   *
   * Both fields are optional for the duration of the dual-read transition;
   * chunk 6 makes them required.
   */
  residualKw?: {
    shed: number;
    restore?: {
      kw: number;
      source: RestorePowerSource;
    };
  };
  // Raw observed binary snapshot input. Planner decisions should resolve through currentState helpers.
  // Present IFF the device has binary control (`controlCapabilityId` set); `.on` is the observed binary
  // state. Absence is equivalent to the old fabricated `currentOn: true` for non-binary devices.
  binaryControl?: { on: boolean };
  currentState?: string;
  // EV fields (`evChargingState`, `evBoost`, `stateOfCharge`) are split off onto
  // the orthogonal `EvPlanInputKind` cluster; reach them through the
  // `isEvPlanDevice` guard (`lib/plan/planEvDevice.ts`).
  powerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
  measuredPowerKw?: number;
  currentTemperature?: number;
  temperatureBoost?: TemperatureBoostConfig;
  // Set by the deferred limit-lower-priority rescue lane (admission) to force boost on while
  // the smart task is in its planned hours; the boost resolvers honour it independent of the
  // device's own boost config/threshold, so the escalation/shedding machinery claims capacity
  // from lower-priority devices.
  forceBoostActive?: boolean;
  /**
   * Producer-resolved deadline floor for the thermostat setpoint, °C — the
   * deadline-target plus learned over-command. Stamped by
   * `applyDeferredAdmissionToInput` for temperature objectives whose current
   * bucket has planned energy. `resolvePlannedTarget` lifts the commanded
   * setpoint to `max(modeTarget + priceOptDelta, deadlineFloorTargetC)` so the
   * device's local thermostat can actually reach the deadline target; outside
   * planned hours the field is absent and the override drops out.
   */
  deadlineFloorTargetC?: number;
  controllable?: boolean;
  managed?: boolean;
  budgetExempt?: boolean;
  available?: boolean;
  zone?: string;
  lastFreshDataMs?: number;
  lastLocalWriteMs?: number;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
  binaryCommandPending?: boolean;
  binaryCommandPendingDesired?: boolean;
  /**
   * Per-step calibrated power view, populated at plan-build time from the
   * persisted power-calibration store. When a `(deviceId, stepId)` pair has
   * confident observations, admission and delivery estimates are learned from
   * samples inside that configured step's power band and bounded by its
   * configured step power.
   * Missing entries mean the planner should fall back to `planningPowerW`
   * from the profile.
   */
  stepPowerCalibration?: Record<string, StepPowerCalibrationView>;
  /**
   * True when the calibration store has a recent positive observation at the
   * device's currently reported step. Used by boost-driven stepped escalation
   * to avoid escalating a device that isn't accepting load at its current
   * step.
   */
  hasRecentObservedDrawAtSelectedStep?: boolean;
};

export type StepPowerCalibrationView = {
  admissionPowerKw: number;
  deliveryPowerKw: number;
};
