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
    class?: string;
    data?: { id?: string };
    virtualClass?: string;
    capabilities?: string[];
    capabilitiesObj?: Record<string, CapabilityValue<unknown> | undefined> & {
        measure_temperature?: CapabilityValue<number>;
        measure_power?: CapabilityValue<number>;
        meter_power?: CapabilityValue<number>;
        onoff?: CapabilityValue<boolean>;
        target_temperature?: CapabilityValue<number>;
    };
    settings?: Record<string, unknown> & {
        load?: number;
        energy_value_on?: number | null;
        energy_value_off?: number | null;
    };
    energy?: Record<string, unknown> | null;
    energyObj?: Record<string, unknown> | null;
    available?: boolean;
    ready?: boolean;
    unavailableMessage?: string | null;
    zone?: { name?: string } | string;
    zoneName?: string;
};
