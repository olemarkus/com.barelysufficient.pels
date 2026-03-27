export type TargetCapabilitySnapshot = {
  id: string;
  value: unknown;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
};

export type DeviceControlModel = 'temperature_target' | 'binary_power' | 'stepped_load';

export type SteppedLoadCommandStatus = 'idle' | 'pending' | 'success' | 'stale';

export type SteppedLoadActualStepSource = 'reported' | 'assumed' | 'power_heuristic' | 'profile_default';

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
    powerKw?: number;
    expectedPowerKw?: number;
    planningPowerKw?: number;
    expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
    loadKw?: number;
    priority?: number;
    currentOn: boolean;
    evChargingState?: string;
    currentTemperature?: number;
    measuredPowerKw?: number;
    desiredStepId?: string;
    actualStepId?: string;
    assumedStepId?: string;
    selectedStepId?: string;
    actualStepSource?: SteppedLoadActualStepSource;
    lastDesiredStepChangeAt?: number;
    lastStepCommandIssuedAt?: number;
    stepCommandPending?: boolean;
    stepCommandStatus?: SteppedLoadCommandStatus;
    powerCapable?: boolean;
    zone?: string;
    controllable?: boolean;
    managed?: boolean;
    budgetExempt?: boolean;
    capabilities?: string[];
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
