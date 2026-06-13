export type TargetCapabilitySnapshot = {
  id: string;
  value?: number;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  excludeMin?: number;
  excludeMax?: number;
};

export type DeviceControlModel = 'temperature_target' | 'binary_power' | 'stepped_load';

export type SteppedLoadCommandStatus = 'idle' | 'pending' | 'success' | 'stale';

/**
 * The plan-cycle decision PELS made for a device. `shed` = actively held off
 * by PELS, `keep` = allowed to run, `inactive` = not being managed this cycle
 * (capacity control off, manual mode, etc.). Canonical home so the producer
 * (`DevicePlanDevice.plannedState`), the idle-classifier consumer
 * (`IdleClassifierDeviceInput.plannedState`), and test helpers share one union;
 * a typo or new state can't silently slip past the eligibility gate.
 */
export type PlannedDeviceState = 'shed' | 'keep' | 'inactive';

/**
 * Provenance label for the kW used as a device's restore reservation. The
 * canonical home for this union — observer, producer, and plan-layer types
 * all import it from here so a new label can be added in one place. See
 * `lib/observer/observedPower.getRestoreDrawKw`,
 * `lib/device/deviceResidualKw.resolveResidualKwRestore`, and
 * `PlanInputDevice.residualKw.restore.source` for the call sites.
 */
export type RestorePowerSource =
  | 'measured'
  | 'expected'
  | 'planning'
  | 'configured'
  | 'stepped'
  | 'fallback';

export type SteppedLoadStep = {
  id: string;
  planningPowerW: number;
  // Pre-resolved installation current (A) for this step, stamped by the producer
  // for target-power EV presets (`planningPowerW / (230 * phaseCount)`). The
  // executor reads this directly for the `planning_current_a` flow token instead
  // of re-deriving it from the EV target-power preset config. Absent (treated as
  // 0) for capability-built / non-preset stepped profiles.
  planningCurrentA?: number;
};

export type SteppedLoadProfile = {
  model: 'stepped_load';
  steps: SteppedLoadStep[];
  tankVolumeL?: number;
  minComfortTempC?: number;
  maxStorageTempC?: number;
};

export type DeviceControlProfile = SteppedLoadProfile;

export type DeviceControlProfiles = Record<string, DeviceControlProfile>;

export type TargetPowerSteppedLoadPreset = 'ev_charger_1_phase' | 'ev_charger_3_phase';

export type TargetPowerSteppedLoadConfig = {
    enabled?: boolean;
    preset?: TargetPowerSteppedLoadPreset;
    min?: number;
    max?: number;
    step?: number;
    excludeMin?: number;
    excludeMax?: number;
};

export type DeviceTargetPowerConfigs = Record<string, TargetPowerSteppedLoadConfig>;

export type TemperatureBoostConfig = {
    enabled: boolean;
    boostBelowC: number;
};

export type TemperatureBoostSettings = Record<string, TemperatureBoostConfig>;

export type EvBoostConfig = {
    enabled: boolean;
    boostBelowPercent: number;
};

export type EvBoostSettings = Record<string, EvBoostConfig>;

export type DeviceControlAdapterSnapshot = {
    kind: 'capability_adapter';
    activationAvailable?: boolean;
    activationRequired: boolean;
    activationEnabled: boolean;
};

export type DeviceStateOfChargeSnapshot = {
    percent: number;
    observedAtMs?: number;
    status: 'unknown' | 'fresh' | 'stale' | 'invalid';
    capabilityId?: string;
    sessionStartedAtMs?: number;
    invalidatedAtMs?: number;
};

/**
 * A Homey capability id used to drive a device's binary (on/off) control.
 * Intentionally an open string: the *concrete* known binary-control capabilities
 * (`onoff`, `evcharger_charging`, …) are resolved at the device/producer layer
 * (`lib/device/deviceActionProjection.ts`); planner/executor/transport consumers
 * only ever carry the resolved id and must not branch on which one it is.
 */
export type BinaryControlCapabilityId = string;

export type BinaryControlObservation = {
    valid: true;
    capabilityId: BinaryControlCapabilityId;
    observedValue: boolean;
    observedCapabilityIds: string[];
    observedAtMs: number;
    source: 'snapshot_refresh' | 'realtime_capability' | 'device_update';
};

/**
 * Static-ish identity, configuration, and capability metadata for a device.
 * One of the two surfaces that decompose `TargetDeviceSnapshot` by concern (see
 * `notes/state-management/snapshot-decomposition.md`). Nothing here has a
 * realtime in-place write path — these values change only on a full snapshot
 * refresh, never via a Homey capability event — so descriptor reads can never
 * race the fresher-wins merge. `id`/`name` also appear on `ObservedDeviceState`
 * as the join key.
 */
export type DeviceDescriptor = {
    id: string;
    name: string;
    deviceClass?: string;
    deviceType?: 'temperature' | 'onoff';
    communicationModel?: 'local' | 'cloud';
    zone?: string;
    controlModel?: DeviceControlModel;
    controlCapabilityId?: BinaryControlCapabilityId;
    controlAdapter?: DeviceControlAdapterSnapshot;
    controlWriteCapabilityId?: string;
    controlObservationCapabilityId?: string;
    steppedLoadProfile?: SteppedLoadProfile;
    suggestedSteppedLoadProfile?: SteppedLoadProfile;
    targetPowerConfig?: TargetPowerSteppedLoadConfig;
    // Capabilities PELS writes when it natively controls this stepped-load
    // device (max_power_* / onoff / target_power). Populated for stepped-load
    // candidates even when native wiring is off. Used by native-wiring
    // flow-conflict detection (notes/native-wiring/); not a control input.
    nativeWriteCapabilities?: readonly string[];
    // Set when a user Homey Flow writes a capability PELS would natively
    // control for this device, so PELS holds off auto-enabling native wiring
    // (notes/native-wiring/). Drives the device-detail conflict banner.
    // `flowName` is present only when a single named Flow is responsible, so
    // the banner can name it; absent otherwise (generic copy).
    flowConflict?: { conflictingCapabilities: readonly string[]; flowName?: string };
    flowBacked?: boolean;
    flowBackedCapabilityIds?: string[];
    capabilities?: string[];
    canSetControl?: boolean;
    powerCapable?: boolean;
    controllable?: boolean;
    managed?: boolean;
    budgetExempt?: boolean;
    priority?: number;
    // Nameplate / configured power hints — a planning input, NOT measured
    // telemetry (`measuredPowerKw` is the observed value). Kept on the
    // descriptor per the lib/device/AGENTS.md invariant that estimated power stays distinct
    // from observation.
    powerKw?: number;
    expectedPowerKw?: number;
    expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
    loadKw?: number;
};

/**
 * The consolidated observed truth for a device — everything with a realtime
 * in-place write path (a Homey capability event can change it). The other
 * surface that decomposes `TargetDeviceSnapshot` (see
 * `notes/state-management/snapshot-decomposition.md`). This is the value
 * plan/executor decide on; in a later slice it moves onto the observer, fed by
 * the dispatcher push. `id`/`name` are duplicated from `DeviceDescriptor` as
 * the join key so observed-state readers can key/log without a descriptor.
 */
/**
 * Closed set of EV charger plug/charge states, mirroring the Homey
 * `evcharger_charging_state` capability enum. Producers (the capability read in
 * `getEvChargingState`, the native-EV and flow-reported derivations) resolve to
 * this union at their parse seam; consumers branch on it exhaustively. A vendor
 * value outside the set is normalised to `undefined` at the read boundary.
 */
export type EvChargingState =
    | 'plugged_in_charging'
    | 'plugged_in'
    | 'plugged_in_paused'
    | 'plugged_out'
    | 'plugged_in_discharging';

export type ObservedDeviceState = {
    id: string;
    name: string;
    targets: TargetCapabilitySnapshot[];
    // Unified binary observation for whether the device may draw power.
    // This is not the same as "is actively drawing power right now" for devices
    // with richer state, such as EV chargers or stepped loads.
    // Present IFF the device has binary control (`controlCapabilityId` set); `.on`
    // is the observed binary state. A non-binary device has no `binaryControl` —
    // consumers must treat its absence exactly like the old fabricated `currentOn:
    // true` ("may always draw, so stays sheddable").
    binaryControl?: { on: boolean };
    evCharging?: boolean;
    // `evChargingState` is deliberately NOT here (EV-observed slice of the
    // discriminated-types refactor): it lives on `EvObservedFields`, regrouped onto
    // the snapshot by the `isEvObserved` guard
    // (`packages/shared-domain/src/evObservedState.ts`), so an un-narrowed
    // `snapshot.evChargingState` read on a base-typed value is a hard compile
    // error (TS2339). Owner seams (transport/observer producers) and
    // producer-fed structural funnels that physically carry the value before
    // consumers narrow widen with `EvObservedProbe` instead.
    // `stateOfCharge` is deliberately NOT here (state-of-charge-observed slice of
    // the discriminated-types refactor): it lives on `StateOfChargeObservedFields`,
    // regrouped onto the snapshot by the `hasObservedStateOfCharge` guard
    // (`packages/shared-domain/src/stateOfChargeObservedState.ts`), so an
    // un-narrowed `snapshot.stateOfCharge` read on a base-typed value is a hard
    // compile error (TS2339). Owner seams (transport/observer producers) and
    // producer-fed structural funnels that physically carry the value before
    // consumers narrow widen with `StateOfChargeObservedProbe` instead.
    // `currentTemperature` is deliberately NOT here (temperature-observed slice
    // of the discriminated-types refactor): it lives on
    // `TemperatureObservedFields`, regrouped onto the snapshot by the
    // `hasObservedTemperature` guard
    // (`packages/shared-domain/src/temperatureObservedState.ts`), so an
    // un-narrowed `snapshot.currentTemperature` read on a base-typed value is a
    // hard compile error (TS2339). Owner seams (transport/observer producers)
    // and producer-fed structural funnels that physically carry the value
    // before consumers narrow widen with `TemperatureObservedProbe` instead.
    // `measuredPowerKw`/`measuredPowerObservedAtMs` are deliberately NOT here
    // (measured-power-observed slice of the discriminated-types refactor): they
    // live together on `MeasuredPowerObservedFields`, regrouped onto the snapshot
    // by the `hasObservedMeasuredPower` guard
    // (`packages/shared-domain/src/measuredPowerObservedState.ts`), so an
    // un-narrowed `snapshot.measuredPowerKw` read on a base-typed value is a hard
    // compile error (TS2339). Power-measurement absence is the legitimate common
    // case (most devices don't measure power), so the guard's "present implies a
    // finite, non-negative kW" is what consumers lean on after narrowing — the
    // producer write seams (`managerMeasuredPower` at parse, `managerObservation`
    // at refresh, the `measure_power` branch of `applyFreshnessOnlyCapabilityUpdate`
    // at realtime) only write finite values. Owner seams and producer-fed
    // structural funnels widen with `MeasuredPowerObservedProbe` instead.
    reportedStepId?: string;
    /**
     * @deprecated Raw binary evidence is observer-owned transport state. Consumer
     * code must not read this directly; use observer helpers to resolve observed
     * on/off/current-draw semantics.
     */
    binaryControlObservation?: BinaryControlObservation;
    available?: boolean;
    lastFreshDataMs?: number;
    lastLocalWriteMs?: number;
    lastUpdated?: number;
};

/**
 * The normalized, Homey-free device snapshot transport produces. Expressed as
 * the intersection of its two concern surfaces so the full struct cannot drift
 * from the partition: adding a field forces a decision about whether it is a
 * descriptor (static config) or an observation (realtime-merged). Readers that
 * touch only one surface should narrow to `DeviceDescriptor` /
 * `ObservedDeviceState`; readers spanning both keep this alias.
 */
export type TargetDeviceSnapshot = DeviceDescriptor & ObservedDeviceState;

/**
 * EV observed field cluster (EV-observed slice of the discriminated-types
 * refactor — the observer-snapshot twin of the plan layer's `EvKind`).
 *
 * Like `EvKind`, this is ORTHOGONAL to every other axis (an EV charger is also
 * stepped-controlled), so it is NOT a union member; it is the intersection the
 * `isEvObserved` type-guard (`packages/shared-domain/src/evObservedState.ts`)
 * adds onto a snapshot. `evChargingState` is OMITTED from `ObservedDeviceState`,
 * so an un-narrowed `snapshot.evChargingState` read is a hard compile error
 * (TS2339); consumers must pass through `isEvObserved` (or hold an
 * already-narrowed value) first.
 *
 * `evChargingState` is REQUIRED on the narrowed shape: the guard's predicate
 * proves the plug-state has been observed, so a narrowed consumer branches on a
 * known `EvChargingState` value without re-handling the absent case.
 */
export type EvObservedFields = {
    evChargingState: EvChargingState;
};

/**
 * EV observed cluster as a plain optional: the "might have an observed
 * plug-state" loose shape the OWNER seams carry. Transport stores and mutates
 * snapshots in place across kinds (`lib/device/transport/**` fresher-wins
 * merge), and the observer's projection copies the field before consumers
 * narrow — those producer-side surfaces widen with this probe
 * (`TargetDeviceSnapshot & EvObservedProbe`) instead of re-adding the field to
 * the base. Consumer code must NOT take this shape; it narrows through
 * `isEvObserved`.
 */
export type EvObservedProbe = {
    evChargingState?: EvChargingState;
};

/**
 * Temperature observed field cluster (temperature-observed slice of the
 * discriminated-types refactor — the observer-snapshot twin of the plan layer's
 * `TemperatureKind`).
 *
 * Like the EV cluster, this is ORTHOGONAL to every other axis and is NOT a union
 * member; it is the intersection the `hasObservedTemperature` type-guard
 * (`packages/shared-domain/src/temperatureObservedState.ts`) adds onto a
 * snapshot. `currentTemperature` is OMITTED from `ObservedDeviceState`, so an
 * un-narrowed `snapshot.currentTemperature` read is a hard compile error
 * (TS2339); consumers must pass through `hasObservedTemperature` (or hold an
 * already-narrowed value) first.
 *
 * `currentTemperature` is REQUIRED on the narrowed shape, AND present implies
 * finite: all three producer write seams (`getCurrentTemperature` at parse,
 * `applyMeasuredTemperatureObservation` at snapshot-refresh, and the
 * `measure_temperature` branch of `applyFreshnessOnlyCapabilityUpdate` at
 * realtime) write the field only for a `Number.isFinite` reading and skip
 * anything else. So a narrowed consumer reads a usable `number` without
 * re-checking finiteness — that `Number.isFinite` re-check is the source-distant
 * fallback this slice removes.
 *
 * Unlike `EvObservedFields`, the guard does NOT gate on device kind:
 * `currentTemperature` derives from the `measure_temperature` capability, which a
 * non-temperature `deviceType` device can also carry (deviceType is keyed on
 * target caps, not measure caps). A kind gate would reject a *present* reading
 * (a present-but-rejected gap EV does not have). Consumers that also want the
 * temperature-control kind compose `isTemperatureControlDevice(d) &&
 * hasObservedTemperature(d)` explicitly (see `lib/objectives/samples.ts`).
 */
export type TemperatureObservedFields = {
    currentTemperature: number;
};

/**
 * Temperature observed cluster as a plain optional: the "might have an observed
 * temperature" loose shape the OWNER seams carry (transport stores/mutates it in
 * place; the observer projection and the debug snapshot copy it before consumers
 * narrow). Those producer-side surfaces widen with this probe
 * (`TargetDeviceSnapshot & TemperatureObservedProbe`) instead of re-adding the
 * field to the base. Consumer code must NOT take this shape; it narrows through
 * `hasObservedTemperature`.
 */
export type TemperatureObservedProbe = {
    currentTemperature?: number;
};

/**
 * State-of-charge observed field cluster (SoC-observed slice of the
 * discriminated-types refactor — the observer-snapshot twin of the plan layer's
 * `EvKind.stateOfCharge`).
 *
 * Like the other observed clusters, this is ORTHOGONAL and NOT a union member;
 * it is the intersection the `hasObservedStateOfCharge` type-guard
 * (`packages/shared-domain/src/stateOfChargeObservedState.ts`) adds onto a
 * snapshot. `stateOfCharge` is OMITTED from `ObservedDeviceState`, so an
 * un-narrowed `snapshot.stateOfCharge` read is a hard compile error (TS2339);
 * consumers must pass through `hasObservedStateOfCharge` (or hold an
 * already-narrowed value) first.
 *
 * IMPORTANT — unlike the scalar clusters, `stateOfCharge` is a NESTED bag with
 * its own `status` field. The guard proves the SNAPSHOT OBJECT is present, NOT
 * that `status === 'fresh'` and NOT that `percent` is usable: consumers keep
 * their `status`/freshness gates after narrowing — the guard only removes the
 * outer `?.`/`if (!stateOfCharge)`. (The `percent` finiteness IS guaranteed by
 * the producer's `normalizeStateOfChargePercent`, so this is a pure
 * type-tightening slice with no boundary bug.)
 */
export type StateOfChargeObservedFields = {
    stateOfCharge: DeviceStateOfChargeSnapshot;
};

/**
 * State-of-charge observed cluster as a plain optional: the "might have an
 * observed state-of-charge" loose shape the OWNER seams carry (transport
 * stores/mutates it in place; the observer projection and the debug snapshot
 * copy it before consumers narrow). Those producer-side surfaces widen with this
 * probe (`TargetDeviceSnapshot & StateOfChargeObservedProbe`) instead of
 * re-adding the field to the base. Consumer code must NOT take this shape; it
 * narrows through `hasObservedStateOfCharge`.
 */
export type StateOfChargeObservedProbe = {
    stateOfCharge?: DeviceStateOfChargeSnapshot;
};

/**
 * Measured-power observed field cluster (measured-power-observed slice of the
 * discriminated-types refactor). Like the other observed clusters, this is
 * ORTHOGONAL and NOT a union member; it is the intersection the
 * `hasObservedMeasuredPower` type-guard
 * (`packages/shared-domain/src/measuredPowerObservedState.ts`) adds onto a
 * snapshot. `measuredPowerKw`/`measuredPowerObservedAtMs` are OMITTED from
 * `ObservedDeviceState`, so an un-narrowed `snapshot.measuredPowerKw` read is a
 * hard compile error (TS2339); consumers pass through `hasObservedMeasuredPower`
 * (or hold an already-narrowed value) first.
 *
 * The two fields travel together (a measurement and the time it was observed),
 * so they are kept in one cluster. The guard gates on `measuredPowerKw` only —
 * `measuredPowerObservedAtMs` stays optional on the narrowed shape, and the one
 * staleness-sensitive consumer (`lib/power/sampleIngest.ts`) still checks it
 * independently. `measuredPowerKw` is REQUIRED on the narrowed shape, AND present
 * implies finite + non-negative: every producer write seam (`managerMeasuredPower`
 * at parse, `managerObservation` at refresh, the `measure_power` branch of
 * `applyFreshnessOnlyCapabilityUpdate` at realtime) writes the field only for a
 * `Number.isFinite` reading. So a narrowed consumer reads a usable `number`
 * without re-checking finiteness.
 */
export type MeasuredPowerObservedFields = {
    measuredPowerKw: number;
    measuredPowerObservedAtMs?: number;
};

/**
 * Measured-power observed cluster as a plain optional: the "might have an
 * observed measured power" loose shape the OWNER seams carry (transport
 * stores/mutates it in place; the observer projection and the debug snapshot copy
 * it before consumers narrow). Those producer-side surfaces widen with this probe
 * (`TargetDeviceSnapshot & MeasuredPowerObservedProbe`) instead of re-adding the
 * fields to the base. Consumer code must NOT take this shape; it narrows through
 * `hasObservedMeasuredPower`.
 */
export type MeasuredPowerObservedProbe = {
    measuredPowerKw?: number;
    measuredPowerObservedAtMs?: number;
};

/**
 * Step-command / planning state the app-layer decorator
 * (`setup/appDeviceControlHelpers.decorateSnapshotWithDeviceControl`)
 * resolves for stepped-load devices and writes ON TOP of a
 * `TargetDeviceSnapshot` after transport produces it. These fields do NOT
 * originate in the transport-parsed snapshot; they are launders into the
 * planner via `toPlanDevice` (which independently declares them on
 * `PlanInputDevice`) and read by the settings-UI off the decorated carrier.
 * Kept separate from `TargetDeviceSnapshot` so the raw observed-snapshot type
 * carries no decoration the transport pipeline never writes.
 */
export type SteppedLoadDecoration = {
    selectedStepId?: string;
    planningPowerKw?: number;
    targetStepId?: string;
    desiredStepId?: string;
    previousStepId?: string;
    lastStepCommandIssuedAt?: number;
    stepCommandRetryCount?: number;
    nextStepCommandRetryAtMs?: number;
    stepCommandPending?: boolean;
    stepCommandStatus?: SteppedLoadCommandStatus;
};

/**
 * The decoration carrier: a transport snapshot with the app-layer
 * step-command/planning decoration applied. Returned by the decorator and
 * consumed by the planner producer + settings-UI. Lives here in contracts so
 * the settings-UI (which imports only from `packages/contracts`) can type the
 * decorated device list it receives.
 */
export type DecoratedDeviceSnapshot = TargetDeviceSnapshot & SteppedLoadDecoration;

export type SettingsUiLogLevel = 'info' | 'warn' | 'error';

export type SettingsUiLogEntry = {
    level: SettingsUiLogLevel;
    message: string;
    detail?: string;
    context?: string;
    timestamp: number;
};
