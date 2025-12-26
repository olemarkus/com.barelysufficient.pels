export type TargetDeviceSnapshot = {
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
};

export type Logger = {
    log: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

export type FlowAutocompleteResult = { id: string; name: string };

export type SettingsUiLogLevel = 'info' | 'warn' | 'error';

export type SettingsUiLogEntry = {
    level: SettingsUiLogLevel;
    message: string;
    detail?: string;
    context?: string;
    timestamp: number;
};

export type FlowCard = {
    registerRunListener: (fn: (args: unknown, state?: unknown) => Promise<boolean> | boolean | void) => void;
    registerArgumentAutocompleteListener: (
        arg: string,
        fn: (query: string) => Promise<FlowAutocompleteResult[]> | FlowAutocompleteResult[],
    ) => void;
    trigger?: (tokens?: Record<string, unknown>, state?: Record<string, unknown>) => Promise<void>;
};

export type FlowManagerLike = {
    getTriggerCard: (id: string) => FlowCard;
    getConditionCard: (id: string) => FlowCard;
    getActionCard: (id: string) => FlowCard;
};

export type FlowHomeyLike = {
    flow: FlowManagerLike;
    settings: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };
};

export type CapabilityValue<T> = {
    value?: T;
    units?: string;
};

export type HomeyDeviceLike = {
    id?: string;
    name?: string;
    data?: { id?: string };
    capabilities?: string[];
    capabilitiesObj?: Record<string, CapabilityValue<unknown> | undefined> & {
        measure_temperature?: CapabilityValue<number>;
        measure_power?: CapabilityValue<number>;
        onoff?: CapabilityValue<boolean>;
    };
    settings?: { load?: number };
    zone?: { name?: string } | string;
    zoneName?: string;
};
