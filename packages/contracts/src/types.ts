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
 * `lib/observer/observedPower.getHighestKnownPowerKw`,
 * `lib/device/deviceResidualKw.resolveResidualKwRestore`, and
 * `PlanInputDevice.residualKw.restore.source` for the call sites.
 *
 * `'configured'` and `'fallback'` are gone. The first labelled `powerKw`, which
 * no longer exists; the second labelled "no source carried a positive number",
 * which `expectedPowerKw` being required and always positive makes unreachable.
 */
export type RestorePowerSource =
  | 'measured'
  | 'expected'
  | 'planning'
  | 'stepped';

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

/**
 * A stepped-load control ladder.
 *
 * Deliberately carries NO `model` tag. `DeviceControlProfile` is a union of one,
 * so a `model: 'stepped_load'` field would be a discriminator that discriminates
 * nothing: on an already-typed value every `profile.model === 'stepped_load'`
 * comparison was a presence check in costume. Presence of the profile itself
 * (`steppedLoadProfile`, or a `DeviceControlProfiles` entry) IS the stepped
 * discriminant, by construction.
 *
 * A future SECOND profile type reintroduces a discriminator at the `unknown`
 * parse boundary (`normalizeSteppedLoadProfile` in
 * `packages/contracts/src/deviceControlProfiles.ts` and its runtime mirror in
 * `lib/utils/deviceControlProfiles.ts`) — never downstream on typed values.
 */
export type SteppedLoadProfile = {
  steps: SteppedLoadStep[];
  tankVolumeL?: number;
  minComfortTempC?: number;
  maxStorageTempC?: number;
};

export type DeviceControlProfile = SteppedLoadProfile;

export type DeviceControlProfiles = Record<string, DeviceControlProfile>;

export type TargetPowerSteppedLoadPreset = 'ev_charger_1_phase' | 'ev_charger_3_phase';

/**
 * Runtime-learned reachability for an EV target-power preset.
 *
 * `maxReachedPowerW` is observed device evidence, not the configured probe
 * ceiling (`TargetPowerSteppedLoadConfig.max`). The app-wiring owner persists
 * this state after joining an accepted command with fresh device feedback;
 * planner-facing producers consume only the resolved ladder and strip this
 * provenance before the planner boundary.
 */
export type TargetPowerReachabilityState = {
  profileFingerprint: string;
  maxReachedPowerW: number;
  probeFailureCount: number;
  nextProbeAtMs?: number;
};

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

/**
 * One device's manual "Power when running" figure — the top rung of the
 * expected-power ladder (`lib/device/devicePowerEstimate.ts`).
 *
 * `kw`, while both writers take WATTS from the user (the `set_expected_power_usage`
 * Flow card's `power_w` arg and the device page's field); the conversion belongs
 * at each writer, so the persisted record stays in the runtime's own unit.
 * `ts` is when it was set — stored for the record's own bookkeeping, never
 * surfaced: the owner is told which source is answering NOW, not its history.
 */
export type ExpectedPowerOverride = {
    kw: number;
    ts: number;
};

/** Manual expected-power figures by device id, keyed as persisted. */
export type DeviceExpectedPowerOverrides = Record<string, ExpectedPowerOverride>;

/**
 * The cars a charger MAY associate, as ticked by the user on the charger's page.
 *
 * This is an eligibility set, not an association: it says which class `car`
 * devices are candidates for this charger, never which one is plugged in right
 * now. The association itself is session-scoped and lives only in memory
 * (`lib/device/evCarLinkProducer.ts`) — see `notes/ev-car-link/README.md`.
 *
 * An absent or empty entry means the feature is off for that charger.
 */
export type EvCarAssociationConfig = {
    carIds: string[];
};

export type EvCarAssociations = Record<string, EvCarAssociationConfig>;

/**
 * The car a charger is associated with FOR THE CURRENT SESSION, resolved by the
 * car-link probe and narrowed to the cars the user ticked for this charger.
 *
 * Resolved WHEN READ, never stored on a device snapshot: it is a cross-device
 * inference over live probe state, not an observation of the charger, and a
 * stored copy would go stale between snapshot refreshes and be dropped by every
 * device re-parse.
 *
 * `chargingState` is display-only. It is deliberately NOT merged into the
 * charger's own `evChargingState` and is not read by any control path: the car
 * and the charger observe the same plug independently, and collapsing them would
 * let a car app's reporting lag drive PELS's view of the charger.
 *
 * `socPct` is the car's last reported battery level, absent until it has
 * reported one at all — an omitted value means "never observed", never "zero".
 * It is deliberately NOT gated on the session start: cars publish
 * `measure_battery` on change, so a session normally opens with the last
 * pre-plug reading and nothing new arrives until the level rises, and that
 * reading is still the car's real charge. `socObservedAtMs` carries when it was
 * observed so a consumer can render its age. There is no freshness verdict to
 * ask for and none to invent: nothing decays a level, and whether PELS has one
 * at all is answered by the session (`lib/device/transport/stateOfCharge.ts`).
 *
 * A link the probe recovered from its affinity prior (rather than a live plug
 * coincidence) is presented identically — the distinction is evidence strength
 * for log review, and surfacing it would ask the user to adjudicate something
 * they have no way to judge.
 */
export type AssociatedCarSnapshot = {
    carId: string;
    carName: string;
    chargingState: EvChargingState;
    chargingStateObservedAtMs: number;
    socPct?: number;
    socObservedAtMs?: number;
};

export type DeviceControlAdapterSnapshot = {
    kind: 'capability_adapter';
    activationAvailable?: boolean;
    activationRequired: boolean;
    activationEnabled: boolean;
};

/**
 * Why PELS has no battery level for a charger.
 *
 * Both arms are STATEMENTS ABOUT THE SESSION, never about age or trust: a level
 * is reported on change and can only change while a car is attached, so nothing
 * decays. `not_reported` means no reading belongs to the session running now —
 * none has arrived, or the one PELS holds was taken before this car plugged in.
 * `not_connected` means there is no session: a disconnect is recorded and no
 * reconnect has been observed since.
 */
export type EvSocUnavailableReason = 'not_reported' | 'not_connected';

export type DeviceStateOfChargeSnapshot = {
    /**
     * The level PELS stands behind, or nothing.
     *
     * `unavailable` means there IS no level — not a doubtful one. Consumers read
     * this and nothing else to decide usability; there is no freshness, age, or
     * currency signal to combine it with, and inventing one is the defect this
     * union exists to prevent.
     */
    level:
        | { kind: 'known'; percent: number }
        | { kind: 'unavailable'; reasonCode: EvSocUnavailableReason };
    /**
     * The raw last-reported percentage, kept for the observation layer's own
     * bookkeeping (carry-forward across a refresh, change detection). It is NOT
     * the device's level and must not be read as one — `level` is the answer to
     * that, and it is the only one a consumer may act on.
     */
    percent: number;
    observedAtMs?: number;
    capabilityId?: string;
    sessionStartedAtMs?: number;
    invalidatedAtMs?: number;
    /**
     * Where the level came from. ABSENT means the charger reported it itself —
     * a native capability or the `report_evcharger_battery_level` flow card —
     * which is every reading PELS has ever produced, so existing readers stay
     * correct without narrowing.
     *
     * `'car'` means it was read off the associated car instead, because the user
     * ticked that car for this charger. The charger still owns the session: a
     * plug-out invalidates a car-sourced reading exactly as it does its own.
     */
    source?: 'car';
    /** The car's Homey device id, when `source` is `'car'`. */
    sourceDeviceId?: string;
};

/**
 * A Homey capability id used to drive a device's binary (on/off) control.
 * Intentionally an open string: the *concrete* known binary-control capabilities
 * (`onoff`, `evcharger_charging`, …) are resolved at the device/producer layer
 * (`lib/device/deviceActionProjection.ts`); planner/executor/transport consumers
 * only ever carry the resolved id and must not branch on which one it is.
 */
export type BinaryControlCapabilityId = string;

/**
 * Which rung of the expected-power ladder produced `expectedPowerKw`, in
 * precedence order. Diagnostic and explanatory only: it tells a log reader and
 * the device page where the figure came from. It is NOT a confidence flag —
 * `expectedPowerKw` is always a usable number, and a consumer that branches here
 * to decide whether to trust it has reintroduced the optional this closed set
 * exists to retire.
 */
export type ExpectedPowerSource =
    | 'manual'
    | 'load-setting'
    | 'measured-peak'
    | 'homey-energy'
    | 'default';

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
    // Zone IDENTITY (uuid) retained from the raw payload (string or `{id}`
    // shape), distinct from the `zone` display label. Additive/dormant: no
    // consumer reads it yet — multi-home membership will join it against the
    // transport's zone tree (`DeviceTransport.getZoneTree`).
    zoneId?: string;
    controlModel?: DeviceControlModel;
    controlAdapter?: DeviceControlAdapterSnapshot;
    /** Whether the observer exposes a commandable binary on/off axis. */
    binaryControllable?: boolean;
    /** Semantic device role resolved by the producer; never an SDK capability id. */
    deviceRole?: 'ev_charger';
    // `steppedLoadProfile`/`targetPowerConfig` are deliberately NOT here
    // (stepped-descriptor slice of the discriminated-types refactor): they live on
    // `SteppedLoadDescriptorFields`, regrouped onto the snapshot by the
    // `isSteppedLoadSnapshot` guard
    // (`packages/shared-domain/src/steppedLoadObservedState.ts`), so an un-narrowed
    // `snapshot.steppedLoadProfile` read on a base-typed value is a hard compile
    // error (TS2339). `steppedLoadProfile` IS the kind discriminant — its presence
    // means the device is a stepped load; the profile carries no tag of its own. The
    // guard mirrors the plan layer's `isSteppedLoadDevice`. Owner seams and
    // producer-fed structural funnels widen with `SteppedLoadDescriptorProbe`
    // instead. `suggestedSteppedLoadProfile` STAYS on the base: it is a
    // CONFIGURE-stepping hint shown for NON-stepped (unconfigured) devices, so it is
    // not part of the stepped cluster.
    suggestedSteppedLoadProfile?: SteppedLoadProfile;
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
    capabilities?: string[];
    canSetControl?: boolean;
    powerCapable?: boolean;
    controllable?: boolean;
    managed?: boolean;
    budgetExempt?: boolean;
    priority?: number;
    /**
     * What this device draws while running — a planning input, NOT measured
     * telemetry (`measuredPowerKw` is the observed value). Kept on the descriptor
     * per the lib/device/AGENTS.md invariant that estimated power stays distinct
     * from observation.
     *
     * REQUIRED — never null, never undefined, never absent. `estimatePower`
     * resolves one number from the whole ladder (manual › load-setting ›
     * measured-peak › homey-energy › default), so absence is not a state any
     * consumer can observe. Trust it: do not substitute for it, do not fall back
     * past it, and do not branch on `expectedPowerSource` to decide whether to
     * believe it. The source is for diagnostics and for telling the owner where
     * the figure came from — never for a control decision.
     *
     * There is deliberately no second `powerKw` field. It carried the same number
     * on every rung but the last, where it laundered an invented 1 kW past the
     * field that had honestly declined to guess — and every consumer's
     * `expectedPowerKw ?? powerKw` tail then picked it up.
     */
    expectedPowerKw: number;
    /**
     * Which rung produced `expectedPowerKw`. REQUIRED — there is always a source.
     * Every branch of the ladder returns one, and `PowerEstimateResult` has
     * always said so; leaving it optional here made the contract disagree with
     * the producer that fills it.
     *
     * It was optional to spare fixtures from stating it, defended as "no
     * consumer may branch on it, so absence is harmless". That conflates two
     * different properties: a field can be REQUIRED and still forbidden as a
     * control input. Optionality was never what enforced that rule — this
     * docblock is.
     *
     * Read it to tell the owner where the current figure came from (the device
     * page does, and that is what makes an override decision informed). Never
     * branch on it to decide behaviour.
     */
    expectedPowerSource: ExpectedPowerSource;
    // No `loadKw`. `settings.load` is a SETTINGS READ, and one the producer has
    // already consumed: if it wins the ladder it is published as
    // `expectedPowerKw` with `expectedPowerSource: 'load-setting'`, and if it
    // loses, a consumer reading it would be reading a figure PELS deliberately
    // did not choose. Same defect as the deleted `powerKw` — a second answer to
    // a question this contract answers once.
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
    // Present IFF the device has binary control; `.on`
    // is the observed binary state. A non-binary device has no `binaryControl` —
    // consumers must treat its absence exactly like the old fabricated `currentOn:
    // true` ("may always draw, so stays sheddable").
    binaryControl?: { on: boolean };
    evCharging?: boolean;
    /** Timestamp of the raw `evcharger_charging` boolean-axis observation. */
    evChargingObservedAtMs?: number;
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
    // `temperature` is deliberately NOT here (temperature-observed slice
    // of the discriminated-types refactor): it lives on
    // `TemperatureObservedFields`, regrouped onto the snapshot by the
    // `hasObservedTemperature` guard
    // (`packages/shared-domain/src/temperatureObservedState.ts`), so an
    // un-narrowed `snapshot.temperature` read on a base-typed value is a
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
    // `reportedStepId` is deliberately NOT here (stepped-observed slice of the
    // discriminated-types refactor): it lives on `ReportedStepObservedFields`,
    // regrouped onto the snapshot by the presence-only `hasObservedReportedStep`
    // guard (`packages/shared-domain/src/steppedLoadObservedState.ts`), so an
    // un-narrowed `snapshot.reportedStepId` read on a base-typed value is a hard
    // compile error (TS2339). A non-stepped device never reports a step; a stepped
    // device only carries it once a native/flow step report lands (absent until
    // then), so the guard is presence-only. Owner seams and producer-fed structural
    // funnels widen with `ReportedStepObservedProbe` instead.
    /**
     * @deprecated Raw binary evidence is observer-owned transport state. Consumer
     * code must not read this directly; use observer helpers to resolve observed
     * on/off/current-draw semantics.
     */
    binaryControlObservation?: BinaryControlObservation;
    /**
     * Producer-resolved Homey reachability. REQUIRED: the transport resolves
     * SDK availability and control-trust evidence to a boolean before
     * publishing the snapshot; absence is not an inward domain state.
     */
    available: boolean;
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
    /** Timestamp of the `evcharger_charging_state` observation. */
    evChargingStateObservedAtMs?: number;
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
    evChargingStateObservedAtMs?: number;
};

/**
 * Temperature observed field cluster (temperature-observed slice of the
 * discriminated-types refactor — the observer-snapshot twin of the plan layer's
 * `TemperatureKind`).
 *
 * Like the EV cluster, this is ORTHOGONAL to every other axis and is NOT a union
 * member; it is the intersection the `hasObservedTemperature` type-guard
 * (`packages/shared-domain/src/temperatureObservedState.ts`) adds onto a
 * snapshot. `temperature` is OMITTED from `ObservedDeviceState`, so an
 * un-narrowed `snapshot.temperature` read is a hard compile error
 * (TS2339); consumers must pass through `hasObservedTemperature` (or hold an
 * already-narrowed value) first.
 *
 * The narrowed facet carries both a finite current measurement and the exact
 * finite `target_temperature` value. Neither can appear independently.
 */
export type TemperatureTargetCapabilitySnapshot = Omit<TargetCapabilitySnapshot, 'id' | 'value'> & {
    id: 'target_temperature';
    value: number;
};

/** Atomic, producer-validated temperature-control observation. */
export type TemperatureObservation = {
    currentTemperature: number;
    target: TemperatureTargetCapabilitySnapshot;
};

export type TemperatureObservedFields = {
    temperature: TemperatureObservation;
};

/**
 * Optional only at the facet level: a device may not support temperature
 * control, but a present facet is complete.
 */
export type TemperatureObservedProbe = {
    temperature?: TemperatureObservation;
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
 * IMPORTANT — `stateOfCharge` is a nested bag with its own `status` field. The
 * guard proves the snapshot object is present, NOT
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
 * Stepped-load descriptor cluster (stepped slice of the discriminated-types
 * refactor — the snapshot-level twin of the plan layer's `SteppedLoadKind`).
 *
 * `steppedLoadProfile` is THE kind discriminant: `SteppedLoadProfile` carries no
 * tag of its own (see its docblock), so its presence on a snapshot is what means
 * the device is a stepped load. It is OMITTED from `DeviceDescriptor`, so an un-narrowed
 * `snapshot.steppedLoadProfile` read is a hard compile error (TS2339); consumers
 * pass through `isSteppedLoadSnapshot`
 * (`packages/shared-domain/src/steppedLoadObservedState.ts`) — the snapshot-shaped
 * mirror of `lib/plan`'s `isSteppedLoadDevice` — or hold an already-narrowed value
 * first. `targetPowerConfig` is stepped-only descriptor config that travels with
 * the profile (optional even on a stepped device until configured), so it rides
 * the same cluster.
 */
export type SteppedLoadDescriptorFields = {
    steppedLoadProfile: SteppedLoadProfile;
    targetPowerConfig?: TargetPowerSteppedLoadConfig;
};

/**
 * Stepped-load descriptor cluster as a plain optional: the "might be a stepped
 * load" loose shape the OWNER seams carry (transport stores/mutates the snapshot;
 * the projection and debug snapshot copy these before consumers narrow). Those
 * producer-side surfaces widen with this probe
 * (`TargetDeviceSnapshot & SteppedLoadDescriptorProbe`) instead of re-adding the
 * fields to the base. Consumer code must NOT take this shape; it narrows through
 * `isSteppedLoadSnapshot`.
 */
export type SteppedLoadDescriptorProbe = {
    steppedLoadProfile?: SteppedLoadProfile;
    targetPowerConfig?: TargetPowerSteppedLoadConfig;
};

/**
 * Reported-step observed cluster (stepped-observed slice of the discriminated-types
 * refactor). `reportedStepId` is the observed id of the step a stepped device last
 * reported via a native/flow capability. It is OMITTED from `ObservedDeviceState`,
 * so an un-narrowed `snapshot.reportedStepId` read is a hard compile error
 * (TS2339); consumers pass through the presence-only `hasObservedReportedStep`
 * guard (`packages/shared-domain/src/steppedLoadObservedState.ts`) first.
 *
 * PRESENCE-ONLY, like the other observed clusters: a non-stepped device never
 * reports a step, and a stepped device carries `reportedStepId` only once a report
 * lands (absent until then), so presence — not device kind — is the line the guard
 * draws.
 */
export type ReportedStepObservedFields = {
    reportedStepId: string;
    /** Exact target-power observation retained before rung matching. */
    reportedStepPowerW?: number;
    /** Timestamp of the exact step observation, not general snapshot freshness. */
    reportedStepObservedAtMs?: number;
};

/**
 * Reported-step observed cluster as a plain optional: the owner-seam carrier
 * (`TargetDeviceSnapshot & ReportedStepObservedProbe`). Consumer code narrows
 * through `hasObservedReportedStep` instead of taking this shape.
 */
export type ReportedStepObservedProbe = {
    reportedStepId?: string;
    reportedStepPowerW?: number;
    reportedStepObservedAtMs?: number;
};

/** Observer-maintained value after transport has projected every observed cluster. */
export type ProjectedObservedDeviceState = ObservedDeviceState
    & EvObservedProbe
    & TemperatureObservedProbe
    & StateOfChargeObservedProbe
    & MeasuredPowerObservedProbe
    & ReportedStepObservedProbe;

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
    /**
     * Producer-resolved command-authority override. Raw temperature targets
     * remain on the snapshot for observation, but PELS may issue binary
     * commands only while this marker is present.
     */
    temperatureControlDisabled?: true;
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
 *
 * Intersects the stepped-descriptor + reported-step probes because the decorator
 * (`decorateSnapshotWithDeviceControl`) is the OWNER seam that re-resolves the
 * effective `steppedLoadProfile` and writes it (with `reportedStepId`) onto the
 * carrier — the base type omits those fields. Consumers (flowCards, settings-UI)
 * narrow through `isSteppedLoadSnapshot` / `hasObservedReportedStep`; the probes
 * are all-optional, so they widen the carrier without changing its runtime shape.
 */
/**
 * Applied by the settings-UI devices composer, not by transport: the association
 * is resolved from live probe state at read time (see `AssociatedCarSnapshot`),
 * so it decorates the payload rather than living on the device snapshot.
 */
export type AssociatedCarDecoration = {
    associatedCar?: AssociatedCarSnapshot;
};

export type DecoratedDeviceSnapshot = TargetDeviceSnapshot & SteppedLoadDecoration
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe & AssociatedCarDecoration;

export type SettingsUiLogLevel = 'info' | 'warn' | 'error';

export type SettingsUiLogEntry = {
    level: SettingsUiLogLevel;
    message: string;
    detail?: string;
    context?: string;
    timestamp: number;
};
