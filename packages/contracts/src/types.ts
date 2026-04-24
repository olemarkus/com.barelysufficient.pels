export type TargetCapabilitySnapshot = {
  id: string;
  value?: number;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
};

export type DeviceControlModel = 'temperature_target' | 'binary_power' | 'stepped_load';

export type SteppedLoadCommandStatus = 'idle' | 'pending' | 'success' | 'stale';

export type SteppedLoadActualStepSource = 'reported' | 'assumed' | 'profile_default';

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

export type DeviceControlAdapterSnapshot = {
    kind: 'capability_adapter';
    activationRequired: boolean;
    activationEnabled: boolean;
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
    controlCapabilityId?: 'onoff' | 'evcharger_charging';
    controlAdapter?: DeviceControlAdapterSnapshot;
    controlWriteCapabilityId?: string;
    controlObservationCapabilityId?: string;
    powerKw?: number;
    expectedPowerKw?: number;
    planningPowerKw?: number;
    expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
    loadKw?: number;
    priority?: number;
    // Unified binary observation for whether the device may draw power.
    // This is not the same as "is actively drawing power right now" for devices
    // with richer state, such as EV chargers or stepped loads.
    currentOn: boolean;
    evCharging?: boolean;
    evChargingState?: string;
    currentTemperature?: number;
    measuredPowerKw?: number;
    reportedStepId?: string;
    targetStepId?: string;
    desiredStepId?: string;
    previousStepId?: string;
    actualStepId?: string;
    assumedStepId?: string;
    selectedStepId?: string;
    actualStepSource?: SteppedLoadActualStepSource;
    lastDesiredStepChangeAt?: number;
    lastStepCommandIssuedAt?: number;
    stepCommandRetryCount?: number;
    nextStepCommandRetryAtMs?: number;
    stepCommandPending?: boolean;
    stepCommandStatus?: SteppedLoadCommandStatus;
    powerCapable?: boolean;
    zone?: string;
    controllable?: boolean;
    managed?: boolean;
    budgetExempt?: boolean;
    capabilities?: string[];
    flowBacked?: boolean;
    flowBackedCapabilityIds?: string[];
    canSetControl?: boolean;
    available?: boolean;
    lastFreshDataMs?: number;
    lastLocalWriteMs?: number;
    lastUpdated?: number;
};

export type SettingsUiLogLevel = 'info' | 'warn' | 'error';

export type SettingsUiLogEntry = {
    level: SettingsUiLogLevel;
    message: string;
    detail?: string;
    context?: string;
    timestamp: number;
};
