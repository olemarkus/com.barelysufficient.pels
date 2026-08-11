import type {
  BinaryControlCapabilityId,
  DeviceControlAdapterSnapshot,
  DeviceControlModel,
  DeviceStateOfChargeSnapshot,
  EvBoostConfig,
  EvChargingState,
  ExpectedPowerSource,
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
 * Stepped-control discriminant for the plan-input union. "Stepped load" is a
 * yes/no capability = presence of a valid `steppedLoadProfile`; `controlModel`
 * is a producer-only setting carried as a plain base optional (consumed by the
 * lib/device boost resolvers), NOT the discriminant. The stepped variant
 * requires the profile; the non-stepped variant omits it. Moving
 * `steppedLoadProfile` off the base makes the compiler reject un-narrowed
 * `device.steppedLoadProfile` reads — consumers must pass through
 * `isSteppedLoadDevice` first.
 *
 * The runtime guard lives in `lib/plan/planSteppedLoad.ts`; the kind helper
 * `SteppedLoadKind` in `lib/plan/planTypes.ts` mirrors this stepped shape.
 */
type SteppedPlanInputKind = {
  steppedLoadProfile: SteppedLoadProfile;
  /**
   * The draw the currently selected step is expected to pull. Lives HERE, on
   * the stepped variant, because it is a fact about a step ladder: a device
   * with no ladder has no selected step, so there is no number to carry. As a
   * base optional it was a field every binary and temperature device also
   * "had", always `undefined` — and both producers spent a line explicitly
   * clearing it (`toPlanDevice`, `appDeviceControlHelpers`) to keep it that way.
   *
   * REQUIRED on this variant, like `steppedLoadProfile` beside it, because the
   * producer always has an answer for a device that reaches it. The chain:
   * `asSteppedLoadProfile` admits a profile only if it has a rung above zero
   * (`hasUsableSteppedLoadLadder`), so `getSteppedLoadLowestActiveStep` — the
   * first step with `planningPowerW > 0` — is non-null by construction, so the
   * planning fallback always resolves, so `resolveEffectiveStepId` never
   * answers `'unknown'`, so `selectedStepId` is always a step OF that profile.
   * `resolveSteppedLoadPlanningPowerKw` returns `undefined` only for a missing
   * step id or one absent from the profile, and neither survives that chain.
   *
   * So an absent value here would mean a producer emitted a stepped device with
   * an unusable ladder — a producer bug, to be fixed at the producer. Typing it
   * optional would only invite every consumer to invent an answer for a state
   * the producer refuses to create.
   */
  planningPowerKw: number;
};

// Omits `steppedLoadProfile` entirely (not `?: never`) so an un-narrowed read
// on the union is a hard compile error rather than a silently-permitted
// `SteppedLoadProfile | undefined`. It stays `{}`-shaped (no index signature);
// the discriminant is profile presence alone.
type NonSteppedPlanInputKind = Record<never, never>;

/**
 * EV field cluster for the plan-input contract (EV-variant slice). EV is
 * ORTHOGONAL to the stepped axis (an EV charger can also be stepped), so this
 * is NOT a union member; it is the intersection the `isEvPlanDevice` type-guard
 * (`lib/plan/planEvDevice.ts`) adds onto whichever stepped variant the device
 * is. The fields are OMITTED from `PlanInputDeviceBase`, so an un-narrowed read
 * is a hard compile error; every field is optional because the producer does
 * not guarantee any of them (`evBoost`/`stateOfCharge` only when
 * configured/reported). The plan-input side has no `evBoostActive` (resolved
 * only on the output `DevicePlanDevice`).
 *
 * The EV plug-state sub-classification (`evBlockReason` / `evSessionInactive` /
 * `evChargerNotResumable`) is gone; it was materialized flat on the base
 * alongside `commandableNow` (see `PlanInputDeviceBase`). The raw observed
 * `evChargingState` is not carried at all — the observer owns it
 * (`ObservedDeviceState`).
 */
export type EvPlanInputKind = {
  /**
   * The observed plug-state, REQUIRED on the narrowed shape for the same reason
   * `BinaryPlanInputKind.currentOn` is: the parse boundary guarantees it. Every EV
   * charger exposes `evcharger_charging_state` (the amp/step axis — `target_power`,
   * stepped-load — is a different axis, not a substitute), and one that cannot
   * report a member of the Homey enum for it is dropped rather than managed.
   * Answer every plug-state question from this value through the shared
   * classifiers in `packages/shared-domain/src/evPlugState.ts`.
   */
  evChargingState: EvChargingState;
  evBoost?: EvBoostConfig;
  stateOfCharge?: DeviceStateOfChargeSnapshot;
};

/**
 * Temperature field cluster for the plan-input contract (temperature-variant
 * slice). Temperature is ORTHOGONAL to the stepped axis (an air-treatment unit
 * can also be stepped), so this is NOT a union member; it is the intersection
 * the `isTemperaturePlanDevice` type-guard (`lib/plan/planTemperatureDevice.ts`)
 * adds onto whichever stepped variant the device is. The field is OMITTED from
 * `PlanInputDeviceBase`, so an un-narrowed `device.currentTemperature` read is a
 * hard compile error; it is optional because the producer does not guarantee
 * the sensor reads.
 *
 * The plan-input side carries NO `currentTarget`: the target is resolved from
 * the device's `targets` capability list at plan-build time
 * (`lib/plan/planDevices.ts`); `currentTarget` only exists on the OUTPUT
 * `DevicePlanDevice`'s `TemperatureKind`.
 */
export type TemperaturePlanInputKind = {
  currentTemperature?: number;
};

/**
 * Binary-control field cluster for the plan-input contract. Like
 * `EvPlanInputKind`/`TemperaturePlanInputKind`, binary control is ORTHOGONAL to
 * the stepped axis (a stepped device also has an onoff control), so this is NOT a
 * union member; it is the intersection the `isBinaryPlanDevice` type-guard
 * (`lib/plan/planBinaryDevice.ts`) adds onto whichever stepped variant the device
 * is. `currentOn` is OMITTED from `PlanInputDeviceBase`, so an un-narrowed
 * `device.currentOn` read is a hard compile error; it is REQUIRED on the
 * narrowed shape (a binary device's on-state is always resolved to a concrete
 * boolean). The guard's runtime discriminant is `controlCapabilityId
 * !== undefined` — capability presence is the source of truth for binary status.
 */
export type BinaryPlanInputKind = {
  // The single public on/off truth for a binary device: a strict boolean the
  // producer resolves once (`resolveCurrentOn` — binary axis AND stepped-off fold,
  // no staleness gate). Consumers narrow via `isBinaryPlanDevice` and read this
  // directly; the on/off question is meaningful ONLY for binary devices, so there
  // is no kind-agnostic wrapper. The raw observed `binaryControl` no longer rides
  // on the plan kinds — it stays transport/observer-internal; the producer folds
  // it into `currentState`/`currentOn` once at `toPlanDevice`.
  currentOn: boolean;
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
  // No `observationStale` field: the plan trusts the producer-resolved
  // `currentOn`/`currentState` (staleness is folded in by the observer) and has
  // no right to distrust observer data. Staleness *reporting* is the observer's
  // concern (e.g. the idle classifier, the overview gray-state), sourced from
  // the observer projection — never off the plan device.
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
  controlCapabilityId?: BinaryControlCapabilityId;
  controlAdapter?: DeviceControlAdapterSnapshot;
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
  // Producer-only control-model setting (`temperature_target` / `binary_power` /
  // `stepped_load`). It is NOT the planner's stepped discriminant — that is
  // profile presence (`isSteppedLoadDevice`). Carried here so the lib/device
  // boost resolvers (which receive the whole plan-input device) can read it; the
  // planner itself must not branch on it.
  controlModel?: DeviceControlModel;
  priority?: number;
  /**
   * Producer-resolved bit: true when the device is commandable in this cycle,
   * false when physically blocked (EV unplugged/discharging, snapshot
   * `available === false`). REQUIRED — the dual-read transition this was optional
   * for is over, and the fallback it enabled is deleted. Consumers read it via
   * `isCommandableNow`; nothing re-derives it from raw fields, so absence can
   * never be mistaken for a decision.
   */
  commandableNow: boolean;
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
  // The binary on/off truth (`currentOn`) is split off onto the orthogonal
  // `BinaryPlanInputKind` cluster; reach it through the `isBinaryPlanDevice` guard
  // (`lib/plan/planBinaryDevice.ts`), present IFF the device has binary control
  // (`controlCapabilityId` set) this cycle. The raw observed `binaryControl` is no
  // longer carried — it stays transport/observer-internal. `currentState` (the
  // four-valued reason/UI label) is producer-resolved at `toPlanDevice`.
  currentState?: string;
  // EV fields (`evChargingState`, `evBoost`, `stateOfCharge`) are split off onto
  // the orthogonal `EvPlanInputKind` cluster; reach them through the
  // `isEvPlanDevice` guard (`lib/plan/planEvDevice.ts`).
  /**
   * What the device draws while running, as the producer resolved it. REQUIRED —
   * never null, never undefined, never absent. The twin of `currentDrawKw` below:
   * that one is what the meter says now, this one is what to size a restore,
   * a reserve, or a smart-task step against.
   *
   * `estimatePower` ends its ladder on a default rather than on absence, so
   * "nothing is known about this device" never reaches a consumer. Trust it: do
   * not substitute for it, do not fall back past it, and do not branch on
   * `expectedPowerSource` to decide whether to believe it.
   *
   * The old `powerKw` twin is gone. It held the same number on every rung but the
   * last, where it laundered an invented 1 kW past the field that had honestly
   * declined to guess — and every `expectedPowerKw ?? powerKw` tail in the
   * planner, the objectives layer, and the settings UI then picked it up.
   */
  expectedPowerKw: number;
  // `planningPowerKw` is NOT here: it is a stepped-ladder fact and lives on
  // `SteppedPlanInputKind`, reached through `isSteppedLoadDevice`.
  /** Which rung produced the figure. REQUIRED — see the twin docblock on `DeviceDescriptor`. */
  expectedPowerSource: ExpectedPowerSource;
  /**
   * The device's current draw in kW, as the producer resolved it. REQUIRED —
   * never null, never undefined, never absent.
   *
   * The raw `measuredPowerKw` deliberately does NOT reach this contract. It
   * stays on the transport snapshot, where absence is real and the producer
   * reads it; carrying it here as well would leave two competing answers to
   * "what is this device drawing", which is the whole defect this replaces.
   *
   * The producer ALWAYS resolves a number, so there is no hole to handle: the
   * meter's reading, or `0`. There is no configured-demand rung and no fallback
   * constant — every managed device is metered (verified across a 124-device
   * fleet), and a configured load is a CONSTANT that would not fall to zero when
   * the device switches off, so reading one would cost `currentDrawKw > 0` its
   * meaning.
   *
   * Trust it implicitly. Do not re-validate it, do not substitute for it, do not
   * ask where it came from. `0` means the device is drawing nothing; it is never
   * "unknown" and never a placeholder the producer emitted for lack of an
   * answer.
   */
  currentDrawKw: number;
  // `currentTemperature` is split off onto the orthogonal `TemperaturePlanInputKind`
  // cluster; reach it through the `isTemperaturePlanDevice` guard
  // (`lib/plan/planTemperatureDevice.ts`). `temperatureBoost` stays on the base.
  temperatureBoost?: TemperatureBoostConfig;
  // Set by the deferred limit-lower-priority rescue lane (admission) to force boost on while
  // the smart task is in its planned hours; the boost resolvers honour it independent of the
  // device's own boost config/threshold, so the escalation/shedding machinery claims capacity
  // from lower-priority devices.
  forceBoostActive?: boolean;
  /**
   * This device may hold back the power it needs to reach its LOWEST ACTIVE STEP from the
   * admission of lower-priority devices, so cycling loads cannot nibble away the contiguous
   * block it needs to start.
   *
   * An ADMISSION term, not a selection decision: it sheds nobody and issues no writes. The plan
   * layer (`lib/plan/admission/headroomReserve.ts`) owns the amount, the release, and the bound;
   * this flag only says the device is entitled to one. BOOST-FREE and independent of
   * `forceBoostActive` — it does not escalate this device's own step.
   *
   * Scope is step 1 only. The reserve dies the instant the device is confirmed at or above its
   * lowest active step, so it never constrains anyone while the device climbs afterwards.
   */
  reservesStartupPower?: boolean;
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
  /**
   * Producer-resolved "Run on solar surplus" dump-load posture (PR-7). `true`
   * when the device opted in via `surplusWilling` in the per-device price-opt
   * blob AND is a plain managed, controllable binary device (not temperature,
   * not stepped, not EV). Resolved once at `toPlanDevice`
   * (`resolveSurplusOnlyPosture`); the planner's surplus allocator/hold and the
   * executor's force-ON carve-out stamp read this flat bit and never re-derive
   * it from the blob (resolution-in-producer).
   */
  surplusOnly?: true;
  /**
   * Producer-resolved "Leave off until turned on again" posture. `true` when the
   * device is opted in, PELS observed an outside OFF action, and it is STILL
   * observed off. The outside action is independent of the current plan.
   * Resolved once at
   * `toPlanDevice` from the hold store + `currentOn`; the planner reads this
   * flat bit and never asks why the device is off (resolution-in-producer).
   *
   * Pairing the stored hold with the live off state here is what keeps a stale
   * hold harmless: if the device is on, the posture simply does not apply, so a
   * missed release event can never make the planner ignore a running device.
   */
  externalOffHoldActive?: true;
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
   * True when the calibration store has a recent in-band draw observation at
   * ANY of the device's steps — evidence the device is accepting load (a
   * just-stepped-up device still ramping at the previous step's level counts).
   * `false` means no recent draw was observed at any step AND the reported
   * step has confidence-qualified calibration: the idle-at-setpoint
   * signature. `undefined` means the store has no opinion (no reported step,
   * or warm-up). Consulted by boost-driven swap escalation to avoid pausing
   * a running lower-priority device for a boosted device that isn't drawing.
   */
  hasRecentObservedDraw?: boolean;
};

export type StepPowerCalibrationView = {
  admissionPowerKw: number;
  deliveryPowerKw: number;
};
