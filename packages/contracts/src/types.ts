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

export type BinaryControlObservation = {
    valid: true;
    capabilityId: 'onoff' | 'evcharger_charging';
    observedValue: boolean;
    observedCapabilityIds: string[];
    observedAtMs: number;
    source: 'snapshot_refresh' | 'realtime_capability' | 'device_update';
};

export type TargetDeviceSnapshot = {
    id: string;
    name: string;
    targets: TargetCapabilitySnapshot[];
    deviceClass?: string;
    deviceType?: 'temperature' | 'onoff';
    communicationModel?: 'local' | 'cloud';
    controlModel?: DeviceControlModel;
    steppedLoadProfile?: SteppedLoadProfile;
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
    controlCapabilityId?: 'onoff' | 'evcharger_charging';
    controlAdapter?: DeviceControlAdapterSnapshot;
    controlWriteCapabilityId?: string;
    controlObservationCapabilityId?: string;
    suggestedSteppedLoadProfile?: SteppedLoadProfile;
    targetPowerConfig?: TargetPowerSteppedLoadConfig;
    powerKw?: number;
    expectedPowerKw?: number;
    expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
    loadKw?: number;
    priority?: number;
    // Unified binary observation for whether the device may draw power.
    // This is not the same as "is actively drawing power right now" for devices
    // with richer state, such as EV chargers or stepped loads.
    // Non-optional by contract: the producer always resolves a concrete boolean
    // at the parse boundary. The Homey SDK types don't guarantee a capability
    // value, so on the (should-never-happen, type-driven) missing-value path the
    // value is synthesized there — never optimistic — rather than left absent, so
    // consumers never re-handle "missing". See `resolveUnobservedControlFallback`.
    currentOn: boolean;
    evCharging?: boolean;
    evChargingState?: string;
    stateOfCharge?: DeviceStateOfChargeSnapshot;
    currentTemperature?: number;
    measuredPowerKw?: number;
    measuredPowerObservedAtMs?: number;
    reportedStepId?: string;
    powerCapable?: boolean;
    zone?: string;
    controllable?: boolean;
    managed?: boolean;
    budgetExempt?: boolean;
    capabilities?: string[];
    flowBacked?: boolean;
    flowBackedCapabilityIds?: string[];
    canSetControl?: boolean;
    binaryControlObservation?: BinaryControlObservation;
    available?: boolean;
    lastFreshDataMs?: number;
    lastLocalWriteMs?: number;
    lastUpdated?: number;
};

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
