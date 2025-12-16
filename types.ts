export interface TargetDeviceSnapshot {
    id: string;
    name: string;
    targets: Array<{ id: string; value: unknown; unit: string }>;
    powerKw?: number;
    expectedPowerKw?: number;
    expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'default';
    loadKw?: number;
    priority?: number;
    currentOn?: boolean;
    currentTemperature?: number;
    measuredPowerKw?: number;
    zone?: string;
    controllable?: boolean;
    capabilities?: string[];
    lastUpdated?: number;
}

export interface Logger {
    log: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}
