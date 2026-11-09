import type {
    TargetPowerSteppedLoadConfig,
    TargetPowerSteppedLoadPreset,
} from '../../packages/contracts/src/types';
import { isUnknownRecord, type UnknownRecord } from '../../packages/shared-domain/src/recordGuards';

export type Logger = {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    structuredLog: import('../logging/logger').Logger;
};

export type FlowAutocompleteResult = { id: string; name: string };

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
    settings: {
        get: (key: string) => unknown;
        set: (key: string, value: unknown) => void;
        unset: (key: string) => void;
        getKeys: () => string[];
    };
};

export type CapabilityValue<T> = {
    // The capability id, as Homey's real `capabilitiesObj` entries carry it
    // (the map key duplicates it). Optional so production reads stay unaffected;
    // present here so test fixtures mirroring the SDK shape typecheck.
    id?: string;
    value?: T;
    units?: string;
    min?: number;
    max?: number;
    step?: number;
    excludeMin?: number;
    excludeMax?: number;
    setable?: boolean;
    lastUpdated?: string | number | Date | null;
};

export type HomeyDeviceLike = {
    id: string;
    name: string;
    class: string;
    driverId: string;
    realDriverId?: string;
    ownerUri: string;
    data: {
        id?: string;
        driverId?: string;
        installationId?: string;
    };
    virtualClass: string | null;
    capabilities: string[];
    capabilitiesObj: Record<string, CapabilityValue<unknown> | undefined> & {
        measure_temperature?: CapabilityValue<number>;
        measure_power?: CapabilityValue<number>;
        meter_power?: CapabilityValue<number>;
        onoff?: CapabilityValue<boolean>;
        available_installation_current?: CapabilityValue<number>;
        'alarm_generic.car_connected'?: CapabilityValue<boolean>;
        evcharger_charging?: CapabilityValue<boolean>;
        evcharger_charging_state?: CapabilityValue<string>;
        measure_battery?: CapabilityValue<number>;
        target_temperature?: CapabilityValue<number>;
        target_power?: CapabilityValue<number>;
    };
    settings: Record<string, unknown> & {
        load?: number;
        energy_value_on?: number | null;
        energy_value_off?: number | null;
        pelsCompatibilityOwnerUri?: string;
        pelsCompatibilityDriverId?: string;
        pelsCompatibilityTargetPower?: string | TargetPowerSteppedLoadConfig;
        pelsCompatibilityTargetPowerPreset?: TargetPowerSteppedLoadPreset;
    };
    energy: Record<string, unknown> | null;
    energyObj: Record<string, unknown> | null;
    available: boolean;
    ready: boolean;
    unavailableMessage: string | null;
    /** The zone id. */
    zone: string;
};

export type RawHomeyDeviceLike = UnknownRecord & {
    id?: unknown;
    name?: unknown;
};

const isRecordOrNull = (value: unknown): boolean => value === null || isUnknownRecord(value);
const isStringOrNull = (value: unknown): boolean => value === null || typeof value === 'string';

/**
 * The boundary for a device read from Homey: its server always sends these
 * fields, so past this guard they are trusted and a malformed payload is dropped.
 */
export const isHomeyDeviceLike = (value: unknown): value is HomeyDeviceLike => (
    isUnknownRecord(value)
    && (['id', 'name', 'class', 'driverId', 'ownerUri', 'zone'] as const).every((key) => typeof value[key] === 'string')
    && typeof value.available === 'boolean'
    && typeof value.ready === 'boolean'
    && isStringOrNull(value.virtualClass)
    && isStringOrNull(value.unavailableMessage)
    && isRecordOrNull(value.energy)
    && isRecordOrNull(value.energyObj)
    && isUnknownRecord(value.data)
    && isUnknownRecord(value.settings)
    && isUnknownRecord(value.capabilitiesObj)
    && Array.isArray(value.capabilities)
    && value.capabilities.every((id) => typeof id === 'string')
);
