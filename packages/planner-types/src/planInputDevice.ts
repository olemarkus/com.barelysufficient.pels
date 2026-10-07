import type {
  HomeBatterySetpointRange,
  DeviceControlAdapterSnapshot,
  DeviceControlModel,
  DeviceStartPolicy,
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
   * actualStepSource) collapsed into this producer-resolved field.
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
   * planning fallback always resolves, so `selectedStepId` always names a step.
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
  // No heating/cooling direction here, on purpose. The planner decides outcomes
  // and reads the setpoint each one commands from `TemperatureSetpoints`
  // (`temperatureSetpoints.ts`); every setpoint that depends on the direction,
  // and every comparison of two setpoints, is resolved before it (`lib/thermostat`).
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

/**
 * Power-axis field cluster for the plan-input contract. Like
 * `TemperaturePlanInputKind` and `BinaryPlanInputKind`, it is ORTHOGONAL to the
 * stepped axis, so it is the intersection the `isMeteredPlanDevice` type-guard
 * (`lib/plan/planMeteredDevice.ts`) adds onto whichever variant the device is.
 * `currentDrawKw` is OMITTED from `PlanInputDeviceBase`, so an un-narrowed
 * `device.currentDrawKw` read is a hard compile error: only a device with a
 * power axis can reach the power-limiting logic.
 *
 * Present IFF the device has a real per-device power reading this cycle
 * (`measure_power`, a `meter_power` window, or its Homey Energy live value).
 * A temperature device with no power reading still reaches the plan — mode
 * targets, the price shift and the rest of the temperature logic apply to it —
 * but without this cluster, so it is never limited for power, never counted in
 * managed usage (the whole-home meter counts its draw as background usage), and
 * never priced as denied demand. A device with neither a power reading nor a
 * temperature axis has nothing the plan can do for it and is not planned.
 *
 * The raw `measuredPowerKw` deliberately does NOT reach this contract. It stays
 * on the transport snapshot, where absence is real and the producer reads it;
 * carrying it here as well would leave two competing answers to "what is this
 * device drawing".
 *
 * Trust it implicitly. Do not re-validate it, do not substitute for it, do not
 * ask where it came from. `0` means the device is drawing nothing; it is never
 * "unknown" and never a placeholder — a device without a reading does not carry
 * the field at all.
 */
export type MeteredPlanInputKind = {
  currentDrawKw: number;
};

/**
 * How a home battery has answered PELS's setpoints this run, owned by
 * `lib/battery` (`batteryVerification.ts`) and written from the executor's
 * storage lane:
 *
 * - `unverified` — nothing has been judged yet.
 * - `responding` — the battery's own signed power reached a setpoint (or an
 *   increase plateaued short of it, which is its learned delivery ceiling).
 * - `not_responding` — a setpoint did not move the battery's own power within
 *   the confirmation window. The plan hands the battery back until the
 *   back-off ends.
 * - `reprobing` — the back-off ended and the battery may be driven again, but
 *   it has not answered since: its setpoints earn no credit.
 * - `sign_inverted` — the battery's reported power moved opposite to the
 *   whole-home meter across several setpoint steps. Control stays off until the
 *   app restarts.
 */
export type StorageVerdict = 'unverified' | 'responding' | 'not_responding' | 'reprobing' | 'sign_inverted';

/** A battery PELS can read this cycle: its own signed power is observed. */
export type ObservedStorageInput = {
  reading: 'observed';
  /** The writable setpoint range, its grid (`stepW`, W) and exclusion band. */
  range: HomeBatterySetpointRange;
  handBackDeferred: boolean;
  /** The battery's own signed power, W: positive charging, negative discharging. */
  signedPowerW: number;
  /** PELS holds a recorded claim on the battery (it owes a hand-back). */
  claimHeld: boolean;
  /** PELS may hold the battery: control on, Main home, claim recordable, not in simulation. */
  admissible: boolean;
  /**
   * The owner's Power-limit control for this battery, read through the
   * battery's own gate (`isBatteryPowerLimitEnabled`), never as a load's
   * command authority. Off: PELS never takes it over at all (owner ruling,
   * 2026-10-06): no charge cap, no discharge and no surplus claim. It is no
   * shed candidate and no surplus claimant, and its own app is in charge.
   */
  powerLimitControl: boolean;
  verdict: StorageVerdict;
  /**
   * The most discharge PELS may ask for, W: the discharge range, or less once
   * an increase plateaued short of what it asked.
   */
  deliveryCeilingW: number;
  /**
   * The most charge PELS may ask for, W: the charge range, or less once a
   * charge stopped short of what it asked (a full battery stops at 0 W).
   */
  chargeCeilingW: number;
};

/**
 * A battery PELS holds a claim on but cannot read this cycle: Homey reports it
 * unavailable, or its own power is not observed. Enough to keep or release the
 * hold, never enough to credit it.
 */
export type MissingStorageInput = {
  reading: 'missing';
  handBackDeferred: boolean;
  claimHeld: true;
  admissible: boolean;
};

/**
 * A battery PELS can only watch: Managed on, in the Main home, read this
 * cycle, but with no setpoint surface PELS could drive (its control owner
 * reads no lever on it). Only its own signed power is carried, so its
 * discharge counts against the surplus pool and the surplus hard-off
 * (`resolveStorageSurplus`): stored energy is never surplus, whoever drives
 * the battery. PELS never holds it, so it is never a surplus claimant, never a
 * limiting candidate and never handed back; every other storage stage treats
 * it as a battery without a lever.
 */
export type WatchedStorageInput = {
  reading: 'watched';
  /** The battery's own signed power, W: positive charging, negative discharging. */
  signedPowerW: number;
};

/**
 * Home-battery (storage) field cluster for the plan-input contract. Like the
 * metered cluster it is ORTHOGONAL and omitted from the base: present only on a
 * Main-home battery whose control surface is a signed setpoint, and either
 * readable or held by PELS; or on a Managed one PELS can only watch, read
 * this cycle (`WatchedStorageInput`). "No cluster" is the whole of "no lever", so the
 * planner never reads a zero it did not measure. Reach it through
 * `hasStorageInput` (`lib/plan/battery/storageLadder.ts`).
 *
 * The device is `isBatteryOrSolar` with no generic command authority: no
 * generic shed, restore or surplus lane commands it. The storage stage reads
 * this cluster (`lib/plan/battery/`), the shedding walk offers the battery as
 * its own ranked candidate (`lib/plan/shedding/storageCandidate.ts`), the
 * restore lane hands it back (`lib/plan/restore/storageHandBack.ts`), and the
 * builder ranks the batteries in the surplus pool (`resolveStorageSurplus`):
 * the solar a battery stores that PELS can free, at its priority, and its
 * discharge, which is never surplus.
 *
 * State of charge is not here: the battery's own floor applies (owner ruling,
 * 2026-10-05), so nothing decides on it. A battery that stops delivering near
 * empty is caught by its verdict and learned delivery ceiling instead.
 */
export type StoragePlanInputKind = {
  storage: ObservedStorageInput | MissingStorageInput | WatchedStorageInput;
};

export type PlanInputDevice =
  | (PlanInputDeviceBase & SteppedPlanInputKind)
  | (PlanInputDeviceBase & NonSteppedPlanInputKind);

export type PlanInputDeviceBase = {
  id: string;
  name: string;
  targets: TargetCapabilitySnapshot[];
  /** Producer-resolved from the temperature cluster (`resolveTemperatureInputFields`). */
  deviceType: 'temperature' | 'onoff';
  /**
   * Producer-resolved device identity, for the surfaces that ask "is this an EV
   * charger" — never re-derived downstream.
   *
   * Identity, not observation, so it belongs on the plan device where
   * `stateOfCharge` and a plug-state do not. The transport resolves it once
   * from class `evcharger` (`managerParseDeviceFields`), and device
   * configuration carries it onto the
   * planner input. Required: as an optional role it went missing when planner
   * input stopped carrying inventory metadata, and "absent" read as "not a
   * charger" everywhere.
   */
  isEvCharger: boolean;
  /**
   * Resolved by device configuration from the inventory class: a home battery
   * or solar device, never a load the generic shed/restore lanes command (a
   * battery is commanded only through the storage stage). The planner has no
   * class to re-read.
   */
  isBatteryOrSolar: boolean;
  /**
   * Resolved by device configuration from the inventory class: a
   * thermostat-family device whose "held below target" PELS reports as
   * starvation. The planner has no class to re-read.
   */
  starvationSupported: boolean;
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
  // No `evBoost` / `temperatureBoost`: a boost threshold is configuration. The
  // producer reads it at its own seam and hands the planner
  // `boostSupported`/`boostRequested` above; the settings UI reads it from that
  // same seam for display.
  //
  // `stateOfCharge` USED to be listed here as absent too, and it was not: the
  // producer's rest-spread carries it onto every plan device, and the objectives
  // layer reads it straight off this object (`ObjectiveDeviceInput`). Removing it
  // on this comment's word turned every EV smart task's progress into
  // `objective_progress_stale` (2026-08-16, reverted). Nothing in `lib/plan` may
  // read it — the planner holds no battery level — but saying it is not here was
  // false, and a comment that a rest-spread silently contradicts is worse than no
  // comment. What carries it is now declared at the producer
  // (`PlanDeviceCarriedKey`, `lib/planInput/projectPlanInputDevice.ts`), where a compile
  // error fires if the set changes.
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
   * Neither includes the runnable gate (`control` / `available`):
   * `commandAuthority` gains the deferred-objective term after this producer has
   * run, so `resolveBoostActive` (`lib/plan/planBoost.ts`) applies the posture at
   * plan time.
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
   * cycle (`canSetControl !== false`). Consumers MUST go through
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
  // `currentDrawKw` is split off onto the orthogonal `MeteredPlanInputKind`
  // cluster; reach it through the `isMeteredPlanDevice` guard
  // (`lib/plan/planMeteredDevice.ts`), present IFF the device has a real
  // per-device power reading this cycle.
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
   * `applyDeferredAdmissionToInput` for temperature objectives in a booked
   * (`planned`) hour, also one booked at 0 kWh, where the floor is what lets the
   * thermostat heat if capacity turns out to be free. `resolvePlannedTarget` lifts the commanded
   * setpoint to `max(modeTarget + priceOptDelta, deadlineFloorTargetC)` so the
   * device's local thermostat can actually reach the deadline target; outside
   * planned hours the field is absent and the override drops out.
   */
  deadlineFloorTargetC?: number;
  /**
   * What PELS is permitted to do with this device — see {@link DeviceControlPosture}.
   *
   * One object rather than loose booleans, and required rather than optional:
   * the producer answers all three for every device, so an absent value would
   * mean a producer that forgot rather than a device without an answer. Read the
   * member that matches your question — `managed` for whether PELS may touch it,
   * `commandAuthority` for whether it may command it this cycle — and do not
   * re-derive one from the other.
   */
  control: DeviceControlPosture;
  /**
   * Producer-resolved "Run on solar surplus" dump-load posture (PR-7). `true`
   * when the device opted in via `surplusWilling` in the per-device price-opt
   * blob AND is a plain managed, controllable binary device (not temperature,
   * not stepped, not EV). Resolved once at `toPlanDevice`
   * (`resolveSurplusOnlyPosture`); the planner's surplus allocator/hold and
   * the shed record's posture stamp (`ShedDecisions.recordPlannedShed`) read
   * this flat bit and never re-derive it from the blob (resolution-in-producer).
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
  // republished through the (since removed) live-state merge changed what
  // `DevicePlanDeviceBase.binaryCommandPending` meant. The plan OUTPUT still
  // carries that bit, resolved through the store's predicate; the plan INPUT
  // does not carry it at all.
  /**
   * The calibrated power for each step, in kW, populated at plan-build time
   * from the persisted power-calibration store. When a `(deviceId, stepId)`
   * pair has confident observations the value is learned from samples inside
   * that configured step's power band and bounded by its configured step
   * power; otherwise it is the configured step power itself.
   *
   * ONE number per step, not a band. It used to be a two-field view whose
   * fields were produced by the same function, which invited consumers to read
   * an "admission" and a "delivery" end that were always equal.
   *
   * Read by smart-task energy planning only (`ObjectiveDeviceInput`, which this
   * device is assigned to structurally): how fast a rung delivers. The planner
   * never reads it. Every capacity decision prices a rung at its profile
   * `planningPowerW` (`resolveStepChangeKw`), because a learned figure is never
   * above nameplate and an under-priced rung is admitted into room it does not
   * fit. Missing entries mean the smart task falls back to `planningPowerW`.
   */
  stepPowerCalibration?: Record<string, number>;
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
   * `resolveConfirmedNotDrawing` (`lib/planInput/calibrationViews.ts`).
   */
  confirmedNotDrawing: boolean;
  /**
   * Who may start this device — see {@link DeviceStartPolicy}.
   *
   * REQUIRED and producer-resolved: absence of an entry in the settings map is
   * `'unrestricted'`, which is an answer rather than a gap, so no consumer
   * branches on presence. `resolveDeviceStartPolicy` owns that default.
   *
   * This is the owner's SETTING, and the plan reads it as a setting in one place:
   * `releaseAbandonedSurplusPosture`, which has to tell an owner who switched
   * the policy off (a withdrawal, answered by "Leave off until turned on
   * again") from a policy that merely stopped applying because Power-limit
   * control came on (not a withdrawal: PELS now starts the device on capacity).
   * Everything that asks what the policy DOES this cycle reads
   * {@link startPolicyInForce}.
   */
  startPolicy: DeviceStartPolicy;
  /**
   * The start policy that applies: the owner's {@link startPolicy} while
   * Power-limit control is off, `'unrestricted'` while it is on.
   *
   * With power limiting on PELS already decides when the device runs: it limits
   * it to stay under the cap and starts it again when there is room. A baseline
   * of off on top of that only overrides PELS's own capacity decisions with
   * "stay off unless a smart task says otherwise", which left a charger parked
   * at 46% with the house under its cap once its task's deadline passed (owner
   * ruling, 2026-09-25). So the policy is the lever for power limiting OFF,
   * which is the case it was built for, and nothing else.
   *
   * REQUIRED and producer-resolved (`resolveStartPolicyInForce`). The
   * start-policy hold, the smart-task lift and the baseline-off stamps read it.
   */
  startPolicyInForce: DeviceStartPolicy;
  /**
   * A smart task is ACTIVELY DRIVING this device this cycle, so its
   * start-policy baseline of off does not apply — the one thing in PELS that
   * positively starts a device has booked this hour (with or without energy
   * promised) and wants it running.
   *
   * Stamped by `applyDeferredAdmissionToInput` on a `planned` admission
   * decision, and only there. It is a per-cycle DERIVATION,
   * deliberately not a rewrite of {@link startPolicyInForce} above: runtime code
   * overwriting a producer-resolved setting mid-cycle is the exact shape the
   * `controllable: true` admission write was removed for — every downstream
   * reader then had to know whether it ran before or after admission. The two
   * baseline-off stamps that must survive an authority withdrawal
   * (`ShedDecisions.recordPlannedShed`, `releaseAbandonedSurplusPosture`) read
   * the policy in force, unlifted, for that reason; everything that asks "is
   * the hold in force right now" reads it through `isStartPolicyHeldDevice`.
   *
   * Narrower than `admittedDeviceIds` on purpose: a device its own task left
   * `idle` or `inactive` this hour stays held, because an hour the task decided
   * it can do without is not an hour the task is driving it (owner rulings,
   * 2026-09-10). An hour booked at 0 kWh does lift it: the task wants the hour on
   * price, or cannot finish without it, and the forecast only left no room.
   */
  startPolicyHoldLifted?: true;
  /**
   * The device's smart task is deferring this hour (an `idle` admission
   * decision: nothing booked here, or a later hour is cheaper) and the device
   * has command authority of its own, so the task holds it OFF this cycle.
   *
   * During an active smart task the task decides whether the device runs, also
   * with Power-limit control on (owner ruling, 2026-09-25): the task may aim
   * higher than the mode would (a water heater at 65 °C where the mode says
   * 45 °C), so running as normal in an hour the task skipped spends energy the
   * task has scheduled for a cheaper one. The hold sheds to OFF, not to the
   * owner's limiting floor, which answers capacity pressure and still draws.
   *
   * Stamped by `applyDeferredAdmissionToInput`, and only there, together with
   * the device's membership of the admission's `forceShedSet`. A device the task
   * lends authority to (Power-limit control off) keeps its own route, a release
   * to its configured posture, and is not stamped. A reader asking whether this
   * cycle's shed is the hold alone goes through `isDeferredHoldShed`
   * (`lib/plan/shedding/deferredHold.ts`); a reader asking whether the hold is
   * active reads the flag (starvation eligibility, and the shed side's recovery
   * rule `isNonSteppedDeviceRecovering`).
   */
  deferredHoldActive?: true;
};

/**
 * What PELS is permitted to do with a device, as one thing.
 *
 * These travel together because they are one concept, and because the
 * alternative has already cost the app three separate defects. As loose
 * booleans copied into every contract the plan device touches, `controllable`
 * reached 174 references across 69 files, was re-declared as a per-callee shape
 * in eight places, and went optional in four of them — so `undefined` meant
 * "managed" in the headroom sum. Add a control fact here and it travels
 * everywhere by construction; add another boolean and it must be threaded by
 * hand, which is how the last one drifted.
 *
 * The distinction between the first two is the one the app got wrong. They are
 * two separate owner settings, and folding them into a single boolean made a
 * managed device with power limiting off indistinguishable from a device PELS
 * was told to ignore entirely — which is why an unplanned 6.8 kW charge landed
 * in background usage with no lever and nothing naming the cause.
 */
export type DeviceControlPosture = {
  /**
   * **Managed by PELS.** May PELS touch this device at all? `false` means it is
   * observed and never commanded, and no posture, task or rescue overrides that.
   */
  managed: boolean;
  /**
   * Derived: may PELS command this device THIS CYCLE?
   *
   * The OR of every reason PELS currently has authority, inside `managed`.
   * Power limiting is the standing reason; a smart task driving a deadline is
   * another, contributed by the decorator that owns it.
   *
   * The owner's **Power-limit control** toggle is an INPUT to this, not a
   * sibling of it. It is read once by the producer and does not travel: the
   * planner asks whether it may act, never which of the terms said yes. (Owner
   * ruling, 2026-09-09.) A carried copy would be a second answer to a question
   * nobody asks, kept in step by nothing.
   *
   * Deriving it replaced a mutation: the deferred-objective admission used to
   * write `controllable: true` onto a rescued device, so a user setting changed
   * mid-cycle and every reader had to know whether it ran before or after
   * (`lib/device/deviceActionProjection.ts` documents ordering around exactly
   * that). An OR'd field has no such ordering.
   *
   * NOT `commandableNow`, which asks whether the device can be REACHED right now
   * — availability, plug state, command back-off. A device can be authorized and
   * unreachable, or reachable and unauthorized.
   */
  commandAuthority: boolean;
};

/**
 * What rides onto the plan device on the `...deviceFields` rest-spread, DECLARED.
 *
 * The spread is an exclusion list: it carries everything the destructure below
 * does not strip, so a field added to the device snapshot reaches the planner
 * without anyone choosing that. It is how `stateOfCharge` and `deviceRole` came to
 * ride here undeclared — the contract said a plan device carries neither, the
 * runtime carried both, and only a test run said which was right. Stripping
 * `stateOfCharge` on the contract's word turned every EV smart task's progress
 * into `objective_progress_stale` (2026-08-16, reverted).
 *
 * Listing the carried set makes the next such addition a compile error here — a
 * decision to strip it or to declare it — instead of a silent passenger. It does
 * not change what is carried: the assertion is an equality, so this is exactly the
 * spread's current contents.
 *
 * Two entries are worth reading twice. `stateOfCharge` is the field the contract
 * still says a plan device does not carry; it is stated here rather than in the
 * contract because the objectives layer reads it off this object and removing it
 * regressed production. And `measuredPowerObservedAtMs` rides while its own pair
 * member `measuredPowerKw` is stripped — the contract says the two travel
 * together, and here they do not.
 */
export type PlanDeviceCarriedKey =
  'associatedCar' | 'available' | 'binaryControllable' | 'budgetExempt'
  | 'isEvCharger' | 'isBatteryOrSolar' | 'starvationSupported'
  | 'canSetControl' | 'capabilities' | 'controlAdapter' | 'controlModel'
  | 'controllable' | 'desiredStepId'
  | 'evCharging' | 'evChargingObservedAtMs' | 'evChargingStateObservedAtMs'
  | 'expectedPowerKw' | 'expectedPowerSource'
  | 'id' | 'lastFreshDataMs' | 'lastLocalWriteMs' | 'lastStepCommandIssuedAt'
  | 'lastUpdated' | 'managed' | 'measuredPowerObservedAtMs' | 'name'
  | 'nextStepCommandRetryAtMs' | 'planningPowerKw' | 'powerCapable'
  | 'previousStepId' | 'priority' | 'reportedStepId' | 'reportedStepObservedAtMs'
  | 'reportedStepPowerW' | 'selectedStepId' | 'stateOfCharge' | 'stepCommandPending'
  | 'stepCommandRetryCount' | 'stepCommandStatus' | 'targetStepId'
  | 'targets';

/**
 * Stripped before planning: raw observations and the decorator's own stamps.
 * (The transport's binding ids — `binaryCapabilityId` and its kin — are no
 * longer in this list because they are no longer on the input: since stage 6
 * of the snapshot decomposition the producer takes the join of the two
 * projected surfaces, which never carried them.)
 */
export type PlanDeviceStrippedKey =
  'batteryClaim' | 'batteryLevel' | 'batteryPower'
  | 'binaryControl' | 'binaryControlObservation' | 'evChargingState' | 'measuredPowerKw'
  | 'measuredPowerIsDirectMeasurement' | 'steppedLoadProfile' | 'targetPowerConfig' | 'temperature'
  | 'temperatureAdjustmentsDisabled' | 'temperatureControlDisabled' | 'thermostatMode';
