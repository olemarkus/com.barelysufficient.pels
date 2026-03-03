export type TargetDeviceSnapshot = {
    id: string;
    name: string;
    targets: Array<{ id: string; value: unknown; unit: string }>;
    deviceClass?: string;
    deviceType?: 'temperature' | 'onoff';
    powerKw?: number;
    expectedPowerKw?: number;
    expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
    loadKw?: number;
    priority?: number;
    currentOn?: boolean;
    currentTemperature?: number;
    measuredPowerKw?: number;
    powerCapable?: boolean;
    zone?: string;
    controllable?: boolean;
    managed?: boolean;
    capabilities?: string[];
    canSetOnOff?: boolean;
    available?: boolean;
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
