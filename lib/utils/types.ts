import type {
    DeviceControlAdapterSnapshot,
    DeviceControlModel,
    DeviceControlProfile,
    DeviceControlProfiles,
    SteppedLoadActualStepSource,
    SteppedLoadCommandStatus,
    SteppedLoadProfile,
    SteppedLoadStep,
    TargetCapabilitySnapshot,
    TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';

export type {
    DeviceControlAdapterSnapshot,
    DeviceControlModel,
    DeviceControlProfile,
    DeviceControlProfiles,
    SteppedLoadActualStepSource,
    SteppedLoadCommandStatus,
    SteppedLoadProfile,
    SteppedLoadStep,
    TargetCapabilitySnapshot,
    TargetDeviceSnapshot,
};

export type Logger = {
    log: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    structuredLog: import('../logging/logger').Logger;
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
        fn: (
            query: string,
            args?: Record<string, unknown>,
        ) => Promise<FlowAutocompleteResult[]> | FlowAutocompleteResult[],
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
    min?: number;
    max?: number;
    step?: number;
    setable?: boolean;
    lastUpdated?: string | number | Date | null;
};

type UnknownRecord = Record<string, unknown>;

const isUnknownRecord = (value: unknown): value is UnknownRecord => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

export type HomeyDeviceLike = {
    id: string;
    name: string;
    class?: string;
    driverId?: string;
    realDriverId?: string;
    driverUri?: string;
    ownerUri?: string;
    driver?: {
        id?: string;
        uri?: string;
        owner_uri?: string;
    };
    data?: {
        id?: string;
        driverId?: string;
    };
    virtualClass?: string;
    capabilities?: string[];
    capabilitiesObj?: Record<string, CapabilityValue<unknown> | undefined> & {
        measure_temperature?: CapabilityValue<number>;
        measure_power?: CapabilityValue<number>;
        meter_power?: CapabilityValue<number>;
        onoff?: CapabilityValue<boolean>;
        'alarm_generic.car_connected'?: CapabilityValue<boolean>;
        evcharger_charging?: CapabilityValue<boolean>;
        evcharger_charging_state?: CapabilityValue<string>;
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

export type RawHomeyDeviceLike = UnknownRecord & {
    id?: unknown;
    name?: unknown;
};

export const isHomeyDeviceLike = (value: unknown): value is HomeyDeviceLike => (
    isUnknownRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
);
