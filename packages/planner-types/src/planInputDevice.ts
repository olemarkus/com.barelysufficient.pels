import type {
  DeviceControlAdapterSnapshot,
  DeviceControlModel,
  ExpectedPowerSource,
  RestorePowerSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TargetCapabilitySnapshot,
  TargetPowerSteppedLoadConfig,
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
 * is a producer-only setting carried as a plain base optional, NOT the
 * discriminant. The stepped variant
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
   * Producer-resolved EFFECTIVE step (`reportedStepId` ?? planning fallback).
   * REQUIRED on this variant for the same reason as `planningPowerKw` below:
   * the producer chain guarantees it for every device that reaches it (usable
   * ladder ⇒ lowest-active fallback ⇒ the effective step always resolves), so
   * an absent value would be a producer bug — `resolveSteppedClusterFields`
   * refuses the whole cluster rather than emitting a stepped device without
   * its step. The retired raw-evidence trio (actualStepId / assumedStepId /
   * actualStepSource) collapsed into this plus the typed stepped-state adapter.
   */
  selectedStepId: string;
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
 * Temperature field cluster for the plan-input contract (temperature-variant
 * slice). Temperature is ORTHOGONAL to the stepped axis (an air-treatment unit
 * can also be stepped), so this is NOT a union member; it is the intersection
 * the `isTemperaturePlanDevice` type-guard (`lib/plan/planTemperatureDevice.ts`)
 * adds onto whichever stepped variant the device is. The fields are OMITTED from
 * `PlanInputDeviceBase`, so an un-narrowed `device.currentTemperature` /
 * `device.currentTarget` read is a hard compile error. Both are REQUIRED after
 * narrowing because the producer only stamps the temperature discriminant from
 * an observer-admitted atomic facet, and that facet carries BOTH a finite
 * sensor reading and a finite exact target snapshot — neither can be absent
 * for an admitted temperature device.
 *
 * `currentTarget` is stamped from the facet's `target.value` at `toPlanDevice`
 * (resolution-in-producer): consumers read it narrowed and never reach into the
 * raw `targets` capability list for the value. The `targets` list itself stays
 * on the base for capability METADATA (min/max/step for normalization, id for
 * write routing) — the value truth lives here.
 */
export type TemperaturePlanInputKind = {
  currentTemperature: number;
  currentTarget: number;
};

/**
 * Binary-control field cluster for the plan-input contract. Like
 * `TemperaturePlanInputKind`, binary control is ORTHOGONAL to
 * the stepped axis (a stepped device also has an onoff control), so this is NOT a
 * union member; it is the intersection the `isBinaryPlanDevice` type-guard
 * (`lib/plan/planBinaryDevice.ts`) adds onto whichever stepped variant the device
 * is. `currentOn` is OMITTED from `PlanInputDeviceBase`, so an un-narrowed
 * `device.currentOn` read is a hard compile error; it is REQUIRED on the
 * narrowed shape (a binary device's on-state is always resolved to a concrete
 * boolean). The guard's runtime discriminant is producer-resolved
 * `currentOn !== undefined`; capability routing stays outside the planner.
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
  // No device-observation freshness field: the plan trusts the producer-resolved
  // `currentOn`/`currentState`. Nothing anywhere ages a device observation out —
  // a Homey driver only republishes a capability on value CHANGE, so silence
  // means "unchanged", not "unknown". `available === false` is the one honest
  // "this device is gone" signal, and it comes from the SDK.
  reportedStepId?: string;
  targetStepId?: string;
  // `selectedStepId` is NOT here: it is a fact about a step ladder and lives on
  // `SteppedPlanInputKind`, reached through `isSteppedLoadDevice`.
  desiredStepId?: string;
  previousStepId?: string;
  lastStepCommandIssuedAt?: number;
  stepCommandRetryCount?: number;
  nextStepCommandRetryAtMs?: number;
  controlAdapter?: DeviceControlAdapterSnapshot;
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
  // Producer-only control-model setting (`temperature_target` / `binary_power` /
  // `stepped_load`). It is NOT the planner's stepped discriminant — that is
  // profile presence (`isSteppedLoadDevice`). Carried here so the lib/device
  // boost resolvers (which receive the whole plan-input device) can read it; the
  // planner itself must not branch on it.
  controlModel?: DeviceControlModel;
  /**
   * Producer-resolved STEP-LADDER GAP: `true` when the device is configured as a
   * stepped load but no live ladder resolved this cycle, so the plan device
   * carries neither `steppedLoadProfile` nor `planningPowerKw`.
   *
   * The ladder is a LIVE transport input — a flow-registered stepped profile does
   * not survive an app restart until the Flow re-fires, and SDK reads fail
   * transiently — so its absence is a real, recurring runtime state, distinct
   * from "this device was never stepped". Consumers that must tell the two apart
   * (the smart-task stack: `resolveObjectiveSteps` / `resolvePlanningSpeedKw`)
   * read this flat bit.
   *
   * Resolved once at `toPlanDevice`, which is the only place both halves of the
   * question are visible: the configured intent and the ladder the planner will
   * actually run. A consumer cannot reconstruct it — `withSteppedDiscriminant`
   * strips the whole stepped cluster, so downstream "no profile" alone cannot say
   * whether a ladder was expected (resolution-in-producer, `docs/architecture.md`
   * § "Clean and trusted interfaces between layers").
   *
   * Absent (never `false`) when there is no gap, matching `surplusOnly` /
   * `externalOffHoldActive`.
   */
  steppedLadderMissing?: true;
  /**
   * This device's rank in the home's active mode: unique, gap-free `1..N`, lower
   * wins. REQUIRED — the producer (`buildHomePlanDevices`) ranks the whole planned
   * set through the mode catalog owner before any consumer sees it
   * (`packages/shared-domain/src/modeCatalogResolution.ts`), so there is no
   * unranked device for a consumer to default. The old optional made every
   * comparison site invent its own `?? 100`, which tied every unranked device
   * with every other one.
   */
  priority: number;
  /**
   * Producer-resolved bit: true when the device is commandable in this cycle,
   * false when physically blocked (EV unplugged/discharging, snapshot
   * `available === false`). REQUIRED — the dual-read transition this was optional
   * for is over, and the fallback it enabled is deleted. Consumers read it via
   * `isCommandableNow`; nothing re-derives it from raw fields, so absence can
   * never be mistaken for a decision.
   */
  commandableNow: boolean;
  /** Producer-resolved reason for a false commandableNow decision. */
  commandabilityReason?: 'charger_unplugged' | 'charger_discharging' | 'device_unavailable'
    | 'binary_command_retry';
  /** Producer-resolved objective family; never inferred from transport IDs downstream. */
  objectiveKind?: 'ev_soc' | 'temperature';
  /**
   * Producer-resolved "there is no creditable session to make progress in" —
   * `isEvSessionInactive` for a charger (`plugged_out` / `plugged_in_discharging`),
   * always `false` for everything else. The smart-task lane's only precondition
   * question, and REQUIRED so a future producer change that stops emitting it
   * fails to compile instead of silently reading `undefined` — which is exactly
   * how the raw `evChargingState` read this replaced died unnoticed.
   *
   * Deliberately NOT `commandableNow`: that folds in `available === false` and
   * the binary-command retry back-off, so a plugged-in, charging car whose last
   * command timed out would be reported to its owner as "EV is unplugged — plug
   * in to resume." Commandability and creditable-session are different questions
   * (see the note on `isEvSessionInactive`), and this is the second.
   */
  objectiveSessionInactive: boolean;
  // No `evBoost` / `stateOfCharge` / `temperatureBoost`: a boost threshold is
  // configuration and a battery level is an observation. The producer reads both
  // at their own seams and hands the planner `boostSupported`/`boostRequested`
  // above; the settings UI reads them from those same seams for display.
  /**
   * Producer-resolved boost facts, kind-free by construction. The producer
   * (`resolveBoostSupported` / `resolveBoostRequested` in
   * `lib/device/deviceActionProjection.ts`) resolves the whole question once —
   * can PELS drive this device's step ladder right now, and is the device's
   * store below the floor its owner set — and hands the planner two booleans.
   * The planner never sees a state of charge, a temperature, or a boost config.
   *
   * There is ONE level behind `boostRequested`, not one per device kind: a
   * tank's temperature and a car's battery percentage are the same quantity in
   * different units, and the producer reads it from whichever capability the
   * device has.
   *
   * - `boostSupported`: PELS has a boost it can drive on this device right now.
   *   This is what a FORCED boost needs (the deferred limit-lower-priority
   *   rescue lane sets `forceBoostActive` independently of the device's own
   *   threshold, and must not engage it on a device PELS cannot drive).
   * - `boostRequested`: the device's own policy asks for boost this cycle.
   *   Implies `boostSupported`.
   *
   * Neither includes the runnable gate (`controllable` / `managed` /
   * `available`): `controllable` can still be flipped by deferred-objective
   * admission after this producer has run, so `resolveBoostActive`
   * (`lib/plan/planBoost.ts`) applies those flags at plan time.
   */
  boostSupported: boolean;
  boostRequested: boolean;
  /**
   * Producer-resolved: being off means this device is going without something it
   * needs. True for a thermostat or a water heater — it always wants heat when
   * it is below target — and false where demand depends on a session the device
   * may not have, which today means a charger with no car plugged in.
   *
   * Consumers ask this instead of asking what KIND of device it is. The
   * diagnostics unmet-demand and starvation lanes used to read
   * `objectiveKind === 'ev_soc'` and the surplus dump-load gate the same, which
   * put the one question the planner must never ask — "is this an EV?" — in
   * three places, each free to answer it differently.
   */
  hasStandingDemand: boolean;
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
   *   pair. The `source` label names the rung that answered
   *   (`RestorePowerSource`). The producer keeps the stepped-vs-binary asymmetry
   *   intact: stepped+on uses live `planningPowerKw` (source `'planning'`),
   *   stepped+off uses the lowest-active step from the profile (source
   *   `'stepped'`), everything else falls back to the observer's
   *   `getHighestKnownPowerKw` (sources `'measured'` / `'expected'` /
   *   `'planning'`).
   *
   * BOTH halves are REQUIRED: `buildResidualKwForPlanDevice` always returns both,
   * and `toPlanDevice` is its only caller, so a device without a `restore` is a
   * shape the producer cannot emit. Optionality is reserved for genuine absence —
   * it was kept here only for the dual-read transition, and the consumer-side
   * fallback it licensed (`resolveSteppedRestorePower` +
   * `getHighestKnownPowerKw` in `lib/plan/restore/accounting.ts`) was reachable
   * from fixtures alone and is gone with it.
   */
  residualKw: {
    shed: number;
    restore: {
      kw: number;
      source: RestorePowerSource;
    };
  };
  // The binary on/off truth (`currentOn`) is split off onto the orthogonal
  // `BinaryPlanInputKind` cluster; reach it through the `isBinaryPlanDevice` guard
  // (`lib/plan/planBinaryDevice.ts`), present IFF the device has binary control
  // (the observer resolved `currentOn`) this cycle. Raw observed `binaryControl` is no
  // longer carried — it stays transport/observer-internal. `currentState` (the
  // four-valued reason/UI label) is producer-resolved at `toPlanDevice`.
  currentState?: string;
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
  // (`lib/plan/planTemperatureDevice.ts`). `temperatureBoost` is NOT on the base
  // either — no boost config reaches the planner; see the `boostSupported` /
  // `boostRequested` docblock above.
  // Set by the deferred limit-lower-priority rescue lane (admission) to force boost on while
  // the smart task is in its planned hours; `resolveBoostActive` honours it independent of the
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
  /** Producer-resolved control eligibility; absence is not a planner state. */
  controllable: boolean;
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
   * Producer-resolved "Match solar surplus" tracking posture. Always present:
 * the producer answers this for every device, so an absent value would mean a
 * producer that forgot rather than a device without an answer. `true` when the
   * device opted in via `surplusWilling` in the per-device price-opt blob AND
   * carries a usable step ladder (a stepped load, which is what an EV charger
   * under a current-control preset is). The modulating sibling of
   * {@link surplusOnly}: rather than a baseline-off hold, the allocator parks
   * the device on the highest rung its allocated surplus covers.
   *
   * Deliberately NOT gated on `hasStandingDemand`. That bit exists because a
   * binary dump load being off means going without, and because a charger with
   * no car would reserve surplus it never draws. The second concern is real and
   * is answered by `commandableNow` at the allocator instead — an unplugged
   * charger cannot claim the pool — so the planner still never asks whether a
   * device is an EV.
   */
  surplusTracking: boolean;
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
  /** Producer-resolved device reachability; absence is not a planner state. */
  available: boolean;
  zone?: string;
  lastFreshDataMs?: number;
  lastLocalWriteMs?: number;
  stepCommandPending?: boolean;
  stepCommandStatus?: SteppedLoadCommandStatus;
  // No binary pending-command pair. Every consumer that decides on in-flight
  // binary command state asks `PendingBinaryCommandStore`
  // (`lib/observer/pendingBinaryCommands`) directly — the builder via
  // `deps.pendingBinaryCommandStore` (`lib/plan/planDevices.ts`), the executor
  // via its own `getCommandState` seam.
  //
  // A producer-stamped copy here could not be right for both of them, because
  // "in flight" is two questions: `hasActiveTurnOn` (what the owner-facing
  // "Resuming" state and the restore serializer mean) and `hasActiveCommand`
  // (any direction — what the shortfall log means). The producer answered the
  // second and the builder the first, under one field name, so a device
  // republished through `planLiveStateMerge` changed what
  // `DevicePlanDeviceBase.binaryCommandPending` meant. The plan OUTPUT still
  // carries that bit, resolved through the store's predicate; the plan INPUT
  // does not carry it at all.
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
   * Producer-resolved: the calibration store is confident this device is
   * drawing nothing right now — the idle-at-setpoint signature (no recent
   * in-band draw at ANY step, and the reported step's calibration is
   * confidence-qualified). A just-stepped-up device still ramping at the
   * previous step's level reads `false`, which is what keeps a boosted
   * staircase climbing.
   *
   * REQUIRED and two-state: "the store has no opinion" is `false`, because
   * absence of evidence is not evidence of idleness. Read by
   * `resolveBoostActive` (`lib/plan/planBoost.ts`), which releases the boost —
   * a claim on other devices' power — from a device that cannot spend it. See
   * `resolveConfirmedNotDrawing` (`setup/appInit/calibrationViews.ts`).
   */
  confirmedNotDrawing: boolean;
};

export type StepPowerCalibrationView = {
  admissionPowerKw: number;
  deliveryPowerKw: number;
};
