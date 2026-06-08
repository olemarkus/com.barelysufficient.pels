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
    // descriptor per the CLAUDE.md invariant that estimated power stays distinct
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
    evChargingState?: string;
    stateOfCharge?: DeviceStateOfChargeSnapshot;
    currentTemperature?: number;
    measuredPowerKw?: number;
    measuredPowerObservedAtMs?: number;
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
 * Step-command / planning state the app-layer decorator
 * (`lib/app/appDeviceControlHelpers.decorateSnapshotWithDeviceControl`)
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
