/**
 * Validate Homey fields independently, then let each feature's admission gate
 * consume the resolved values. Rejected binary readings supply no binary
 * facet, including after an earlier accepted read. Other observation owners
 * may retain accepted readings at their original source dates.
 *
 * Native control metadata is independent of its rejected scalar reading. An
 * unreadable envelope ignores the whole read; otherwise normal admission may
 * omit a device only when none of its supported features remains usable.
 */
import { applyDeviceCompatibilityMetadata } from '../compatibility';
import { isReportedThermostatMode } from './thermostatModeRealtime';
import { normalizeStateOfChargePercent } from './stateOfCharge';
import type { HomeyDeviceLike } from '../../utils/types';
import { isUnknownRecord } from '../../../packages/shared-domain/src/recordGuards';
import { isEvCarDeviceClass } from '../evCarDeviceClass';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import type { DeviceReadRule } from '../deviceAdapter';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import { applyNativeEvWiringOverlay } from '../nativeEvWiring';
import { isEvChargingState } from '../../../packages/shared-domain/src/evPlugState';
import { isBatteryOrSolarClassKey, resolveDeviceClassKey } from './managerHelpers';

type ModelValueType = DeviceReadRule;
const NO_MODEL_CAPABILITIES: Readonly<Record<string, ModelValueType>> = {};

/**
 * Every Homey capability PELS reads as device state from a parsed device, with
 * the value type the model reads it as. The set a declared capability must
 * satisfy.
 */
const DEVICE_MODEL_CAPABILITY_TYPES: Readonly<Record<string, ModelValueType>> = {
    onoff: 'boolean',
    evcharger_charging: 'boolean',
    evcharger_charging_state: 'string',
    measure_temperature: 'number',
    target_temperature: 'number',
    measure_power: 'number',
    meter_power: 'number',
    measure_battery: (value) => normalizeStateOfChargePercent(value) !== undefined,
    measure_soc_usable: (value) => normalizeStateOfChargePercent(value) !== undefined,
    measure_soc_level: (value) => normalizeStateOfChargePercent(value) !== undefined,
    thermostat_mode: isReportedThermostatMode,
    target_power: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    target_power_mode: (value) => value === 'homey' || value === 'device',
};

/**
 * Classes `car` and `vehicle` never survive parse: PELS's whole model of a car is what the
 * EV car-link probe reads from it (`evCarLinkObservation.ts`). The rest of a
 * car's capabilities are none of PELS's business — a Polestar that has never
 * reported its interior `measure_temperature` must not cost the charger the
 * car's state of charge.
 */
const CAR_MODEL_CAPABILITY_TYPES: Readonly<Record<string, ModelValueType>> = {
    ev_charging_state: 'string',
    measure_battery: (value) => normalizeStateOfChargePercent(value) !== undefined,
};

/**
 * PELS reads temperature only as the temperature facet, which needs the
 * measurement AND the target (`resolveTemperatureObservation`); a thermostat
 * mode matters only to such a device. A device declaring a lone internal
 * temperature — a charger, a plug, a cooktop — is never read for it, so a
 * never-reported one is outside the model.
 */
const TEMPERATURE_FACET_CAPABILITY_IDS: ReadonlySet<string> = new Set([
    'measure_temperature',
    'target_temperature',
    'thermostat_mode',
]);

const readsTemperatureFacet = (capabilities: readonly string[]): boolean => (
    capabilities.includes('measure_temperature') && capabilities.includes('target_temperature')
);

/**
 * State of charge is read from an EV charger (`stateOfCharge.ts`) and a home
 * battery (`managerEnergy.ts`) only; a battery-powered thermostat's
 * `measure_battery` is never read.
 */
const STATE_OF_CHARGE_CAPABILITY_IDS: ReadonlySet<string> = new Set([
    'measure_battery',
    'measure_soc_usable',
    'measure_soc_level',
]);
const STATE_OF_CHARGE_CLASS_KEYS: ReadonlySet<string> = new Set(['evcharger', 'battery']);

/**
 * A battery or panel is never a stepped load, so its `target_power` is not read
 * as one. A home battery's `target_power` is read only to classify how PELS
 * could drive it (`batteryControlWiring.ts`), and that reads the declared
 * options, not the value: a battery whose setpoint Homey never set is still
 * readable. A panel's production-cap reports are accepted separately by
 * `solarInverterObservation.ts`, retaining accepted reports on a missing read.
 *
 * Its claim capability is outside these field rules, though its
 * value and stamp ARE read: they are resolved at their own boundary
 * (`resolveParsedClaim`, `homeBatteryObservation.ts`), where a missing or
 * malformed claim keeps the last accepted one or reads as unreported. Failing
 * the whole read on it instead would hide the battery's power and state of
 * charge while leaving its claim exactly as it was.
 */
const STEPPED_ONLY_CAPABILITY_IDS: ReadonlySet<string> = new Set(['target_power', 'target_power_mode']);

/**
 * The capabilities PELS reads from this device, by its role. A device whose
 * class PELS does not admit (a camera, a light, a sensor) is never parsed, so
 * nothing about it is PELS's to check.
 */
function resolveModelCapabilityTypes(
    device: HomeyDeviceLike,
    capabilities: readonly string[],
): Readonly<Record<string, ModelValueType>> {
    if (isEvCarDeviceClass(device)) return CAR_MODEL_CAPABILITY_TYPES;
    const classKey = resolveDeviceClassKey(device);
    if (classKey === null) return NO_MODEL_CAPABILITIES;
    const withTemperatureFacet = readsTemperatureFacet(capabilities);
    const withStateOfCharge = STATE_OF_CHARGE_CLASS_KEYS.has(classKey);
    const withSteppedControl = !isBatteryOrSolarClassKey(classKey);
    const modelTypes = Object.fromEntries(Object.entries(DEVICE_MODEL_CAPABILITY_TYPES).filter(([capabilityId]) => (
        (withTemperatureFacet || !TEMPERATURE_FACET_CAPABILITY_IDS.has(capabilityId))
        && (withStateOfCharge || !STATE_OF_CHARGE_CAPABILITY_IDS.has(capabilityId))
        && (withSteppedControl || !STEPPED_ONLY_CAPABILITY_IDS.has(capabilityId))
        && (capabilityId !== 'target_power_mode' || capabilities.includes('target_power'))
    )));
    return modelTypes;
}

/**
 * What kind of value a rejected reading held, never the value itself. It tells
 * a reading the vendor does not have (`null`) from one of the wrong shape.
 */
export type RejectedValueKind = 'null' | 'absent' | 'boolean' | 'string' | 'number' | 'non_finite' | 'object';

const resolveRejectedValueKind = (value: unknown): RejectedValueKind => {
    if (value === null) return 'null';
    if (value === undefined) return 'absent';
    if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'non_finite';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    return 'object';
};

export type DeviceReadContractViolation =
    | { reason: 'missing_capability_entry'; capabilityId: string }
    | { reason: 'unexpected_value'; capabilityId: string; valueKind: RejectedValueKind }
    | { reason: 'missing_stamp'; capabilityId: string };

const hasModelType = (value: unknown, type: ModelValueType): boolean => {
    if (typeof type === 'function') return type(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
};

// A model value beyond its primitive type: a plug state is a closed enum.
const PLUG_STATE_CAPABILITY_IDS = new Set(['evcharger_charging_state', 'ev_charging_state']);
const isModelValue = (capabilityId: string, value: unknown, type: ModelValueType): boolean => (
    PLUG_STATE_CAPABILITY_IDS.has(capabilityId) ? isEvChargingState(value) : hasModelType(value, type)
);

type CapabilityViolation = Extract<DeviceReadContractViolation, { capabilityId: string }>;

/** Keep a typed realtime source report in the same accepted raw read used by refresh. */
export function withAcceptedCapabilityReport(
    device: HomeyDeviceLike,
    capabilityId: string,
    value: unknown,
    observedAtMs: number,
): HomeyDeviceLike {
    const types = {
        ...resolveModelCapabilityTypes(device, device.capabilities),
        ...getDeviceAdapter(device).readRules(device),
    };
    const type = types[capabilityId];
    if (type === undefined || !isModelValue(capabilityId, value, type)) return device;
    return {
        ...device,
        capabilitiesObj: {
            ...device.capabilitiesObj,
            [capabilityId]: { ...device.capabilitiesObj[capabilityId], value, lastUpdated: observedAtMs },
        },
    };
}

/** The raw source fields this device's model and adapter actually read. */
function resolveRawReadTypes(device: HomeyDeviceLike): ReadonlyMap<string, ModelValueType> {
    const { capabilities, capabilitiesObj } = device;
    const integrationTypes = getDeviceAdapter(device).readRules(device);
    const types = { ...resolveModelCapabilityTypes(device, capabilities), ...integrationTypes };
    const readIds = new Set([...capabilities,
        ...Object.keys(integrationTypes).filter((id) => Object.hasOwn(capabilitiesObj, id))]);
    return new Map([...readIds].flatMap((id) => {
        const type = types[id];
        return type === undefined ? [] : [[id, type] as const];
    }));
}

export type DeviceCapabilityResolution = {
    device: HomeyDeviceLike;
    violations: readonly CapabilityViolation[];
    retainedCapabilityIds: readonly string[];
    withheldCapabilityIds: readonly string[];
};

/** A rejected scalar observation does not erase a real supported write operation. */
function resolveReadDescriptorIds(device: HomeyDeviceLike): Set<string> {
    const values = Object.fromEntries(Object.entries(device.capabilitiesObj).flatMap(([id, entry]) => (
        entry === undefined ? [] : [[id, entry]]
    )));
    const overlay = applyNativeEvWiringOverlay(device, device.capabilities, values);
    const descriptors = new Set([
        'measure_temperature', 'target_temperature', 'target_power', 'target_power_mode',
        ...getDeviceAdapter(device).nativeCurrentControls.map((control) => control.capabilityId),
        ...(overlay.binaryWriteCapabilityId ? [overlay.binaryWriteCapabilityId] : []),
    ]);
    // A real write descriptor is not an observed binary facet.
    descriptors.delete('onoff');
    descriptors.delete('evcharger_charging');
    return descriptors;
}

/**
 * Reject fields independently, without refreshing retained observations. A
 * rejected control prerequisite cannot enable an alternative control path.
 */
export function withholdInvalidModelCapabilities(
    device: HomeyDeviceLike,
    previousRead?: HomeyDeviceLike,
): DeviceCapabilityResolution {
    return resolveModelCapabilities(device, resolveRawReadTypes(device), previousRead);
}

function resolveModelCapabilities(
    device: HomeyDeviceLike,
    readTypes: ReadonlyMap<string, ModelValueType>,
    previousRead?: HomeyDeviceLike,
): DeviceCapabilityResolution {
    const violations = [...readTypes].flatMap(([id, type]) => {
        const violation = findEntryViolation(id, device.capabilitiesObj[id], type);
        return violation ? [violation] : [];
    });
    const types = {
        ...resolveModelCapabilityTypes(device, device.capabilities),
        ...getDeviceAdapter(device).readRules(device),
    };
    const descriptorIds = resolveReadDescriptorIds(device);
    const retained = violations.flatMap(({ capabilityId }) => {
        // Binary admission requires the current read's accepted boolean. Native
        // limits retain their own readings/metadata independently of this axis.
        if (capabilityId === 'onoff' || capabilityId === 'evcharger_charging'
            || (types[capabilityId] === 'boolean' && descriptorIds.has(capabilityId))) return [];
        const entry = previousRead?.capabilitiesObj[capabilityId];
        const type = types[capabilityId];
        return entry && type !== undefined && findEntryViolation(capabilityId, entry, type) === null
            ? [[capabilityId, entry] as const] : [];
    });
    const retainedCapabilityIds = retained.map(([id]) => id);
    const rejected = new Set(violations.map(({ capabilityId }) => capabilityId));
    const withheld = new Set([...rejected].filter((id) => !retainedCapabilityIds.includes(id)));
    // A charger's onoff can disable the entire charger rather than pause it.
    if (withheld.has('evcharger_charging') && resolveDeviceClassKey(device) === 'evcharger') withheld.add('onoff');
    // A rejected native control READING does not erase its declared surface or
    // range. Those descriptors let the owner keep the ladder and wait for a
    // real step report, rather than fall back to a binary-only start.
    const descriptors = [...withheld].flatMap((id) => {
        const entry = device.capabilitiesObj[id];
        if (!descriptorIds.has(id) || !isUnknownRecord(entry)) return [];
        const { value: _value, lastUpdated: _lastUpdated, ...descriptor } = entry;
        return [[id, descriptor] as const];
    });
    if (violations.length === 0) {
        return { device, violations, retainedCapabilityIds: [], withheldCapabilityIds: [] };
    }
    return {
        device: {
            ...device,
            capabilities: device.capabilities.filter((id) => !withheld.has(id) || descriptorIds.has(id)),
            capabilitiesObj: Object.fromEntries([
                ...Object.entries(device.capabilitiesObj)
                    .filter(([id]) => !rejected.has(id) && !withheld.has(id)),
                ...retained,
                ...descriptors,
            ]),
        },
        violations,
        retainedCapabilityIds,
        withheldCapabilityIds: [...withheld],
    };
}

/** The first way `device` breaks the contract, or `null` for a conforming read. */
export function findDeviceReadContractViolation(device: HomeyDeviceLike): DeviceReadContractViolation | null {
    return findViolation(device);
}

/** Inspect the converted model for diagnostics; resolution rejects fields independently. */
function findViolation(
    device: HomeyDeviceLike,
): DeviceReadContractViolation | null {
    const { capabilities, capabilitiesObj } = device;
    // Convert to the model first; only then validate.
    const model = applyNativeEvWiringOverlay(device, capabilities, capabilitiesObj as DeviceCapabilityMap);
    const integrationTypes = getDeviceAdapter(device).readRules(device);
    const modelTypes = { ...resolveModelCapabilityTypes(device, model.capabilities), ...integrationTypes };
    // Include the vendor source entries read by session owners, alongside
    // capabilities converted into the shared model.
    const readCapabilities = new Set([...model.capabilities,
        ...Object.keys(integrationTypes).filter((id) => Object.hasOwn(capabilitiesObj, id))]);
    const noEvProjection = getDeviceAdapter(device).retainsPlugObservation(device);
    for (const capabilityId of readCapabilities) {
        // These complete vendor reads are valid, but cannot assert a new EV
        // plug observation. Session ingestion still needs them to revoke control.
        if (noEvProjection && capabilityId === 'evcharger_charging_state') continue;
        const type = modelTypes[capabilityId];
        if (type === undefined) continue;
        const violation = findEntryViolation(capabilityId, model.capabilityObj[capabilityId], type);
        if (violation !== null) return violation;
    }
    return null;
}

/** How one model capability's entry breaks the contract, or `null` if it does not. */
function findEntryViolation(
    capabilityId: string,
    entry: unknown,
    type: ModelValueType,
): CapabilityViolation | null {
    if (!isUnknownRecord(entry)) return { reason: 'missing_capability_entry', capabilityId };
    if (!isModelValue(capabilityId, entry.value, type)) {
        return { reason: 'unexpected_value', capabilityId, valueKind: resolveRejectedValueKind(entry.value) };
    }
    if (toCapabilityTimestampMs(entry.lastUpdated) === undefined) return { reason: 'missing_stamp', capabilityId };
    return null;
}

export type DeviceReadSource = 'device_fetch' | 'device_update';

export type DeviceReadContractEmitter = {
    info: (payload: Record<string, unknown>) => void;
};

type CapabilityReadGap = {
    startedAt: number;
    startedFrom: DeviceReadSource;
    startedWith: 'withheld' | 'retained' | 'removed';
};

type DeviceReadLog = {
    signature: string | undefined;
    gaps: Map<string, CapabilityReadGap>;
};

// Only devices with outstanding gaps are kept, scoped to the owner shared by fetch and live updates.
const readLogsByOwner = new WeakMap<object, Map<string, DeviceReadLog>>();
const CONTROL_CAPABILITIES = ['onoff', 'evcharger_charging', 'target_temperature', 'target_power'];

function deviceReadLogs(owner: object): Map<string, DeviceReadLog> {
    const existing = readLogsByOwner.get(owner);
    if (existing) return existing;
    const logs = new Map<string, DeviceReadLog>();
    readLogsByOwner.set(owner, logs);
    return logs;
}

export function retainDeviceReadLogs(owner: object, devices: readonly HomeyDeviceLike[]): void {
    const logs = readLogsByOwner.get(owner);
    if (!logs?.size) return;
    const presentIds = new Set(devices.map(({ id }) => id));
    for (const id of logs.keys()) {
        if (!presentIds.has(id)) logs.delete(id);
    }
}

/**
 * Resolve one Homey device read into the views PELS reads from it
 * (`DeviceAdapter.projectRead`), each validated against its own previous
 * accepted read, before producers, parsing or tracking can consume any values.
 */
export function resolveDeviceViews(
    owner: object,
    device: HomeyDeviceLike,
    source: DeviceReadSource,
    emitter: DeviceReadContractEmitter,
    previousRead: (deviceId: string) => HomeyDeviceLike | undefined,
): HomeyDeviceLike[] {
    // The views carry the identity the parse reads (`applyDeviceCompatibilityMetadata`), so a
    // device standing in for another app's (a lab mock) is split and routed by that app's adapter.
    const identified = applyDeviceCompatibilityMetadata(device);
    return getDeviceAdapter(identified).projectRead(identified)
        .map((view) => resolveDeviceRead(owner, view, source, emitter, previousRead(view.id)));
}

/** Resolve a view's read before producers, parsing or tracking can consume any values. */
export function resolveDeviceRead(
    owner: object,
    device: HomeyDeviceLike,
    source: DeviceReadSource,
    emitter: DeviceReadContractEmitter,
    previousRead?: HomeyDeviceLike,
): HomeyDeviceLike {
    const readTypes = resolveRawReadTypes(device);
    const resolution = resolveModelCapabilities(device, readTypes, previousRead);
    const logs = deviceReadLogs(owner);
    const existing = logs.get(device.id);
    const removed = findRemovedControls(device, existing, previousRead);
    if (!existing && resolution.violations.length === 0 && removed.length === 0) return resolution.device;

    const log = existing ?? { signature: undefined, gaps: new Map<string, CapabilityReadGap>() };
    const { violations, retainedCapabilityIds, withheldCapabilityIds } = resolution;
    const rejectedIds = new Set(violations.map(({ capabilityId }) => capabilityId));
    const now = performance.now();
    const { id: deviceId, name: deviceName } = device;

    for (const capabilityId of removed) {
        log.gaps.set(capabilityId, { startedAt: now, startedFrom: source, startedWith: 'removed' });
        emitter.info({ event: 'device_control_capability_removed', deviceId, deviceName, source, capabilityId });
    }
    for (const capabilityId of rejectedIds) {
        if (log.gaps.has(capabilityId)) continue;
        const startedWith = retainedCapabilityIds.includes(capabilityId) ? 'retained' : 'withheld';
        log.gaps.set(capabilityId, { startedAt: now, startedFrom: source, startedWith });
    }
    for (const [capabilityId, gap] of takeRecoveredGaps(device, readTypes, rejectedIds, log.gaps)) {
        emitter.info({
            event: 'device_capability_read_recovered', deviceId, deviceName, source, capabilityId,
            startedFrom: gap.startedFrom, startedWith: gap.startedWith,
            observedGapMs: Math.round(now - gap.startedAt),
        });
    }

    const signature = violations.length > 0 ? JSON.stringify({
        violations, retainedCapabilityIds, withheldCapabilityIds,
    }) : undefined;
    if (signature !== undefined && signature !== log.signature) {
        emitter.info({
            event: 'device_capabilities_withheld', deviceId, deviceName, source, capabilityIds: [...rejectedIds],
            violations, retainedCapabilityIds, withheldCapabilityIds,
        });
    }
    if (log.gaps.size > 0) logs.set(device.id, { ...log, signature });
    else logs.delete(device.id);
    return resolution.device;
}

function* takeRecoveredGaps(
    device: HomeyDeviceLike,
    readTypes: ReadonlyMap<string, ModelValueType>,
    rejectedIds: ReadonlySet<string>,
    gaps: Map<string, CapabilityReadGap>,
): Iterable<[string, CapabilityReadGap]> {
    for (const [id, gap] of gaps) {
        if (rejectedIds.has(id)) continue;
        if (readTypes.has(id)) {
            gaps.delete(id);
            yield [id, gap];
        } else if (isCapabilityPresent(device, id)) {
            // The field is present but outside the model's current validation scope.
            gaps.delete(id);
        }
        // A removed field can still return. Keep timing until a valid read or inventory removal.
    }
}

function isCapabilityPresent(device: HomeyDeviceLike, capabilityId: string): boolean {
    return device.capabilities.includes(capabilityId) || Object.hasOwn(device.capabilitiesObj, capabilityId);
}

function findRemovedControls(
    device: HomeyDeviceLike,
    existing: DeviceReadLog | undefined,
    previousRead?: HomeyDeviceLike,
): string[] {
    if (!previousRead) return [];
    const candidates = CONTROL_CAPABILITIES.filter((id) => previousRead.capabilities.includes(id)
        && !existing?.gaps.has(id) && !isCapabilityPresent(device, id));
    if (candidates.length === 0) return [];
    const previousTypes = resolveRawReadTypes(previousRead);
    return candidates.filter((id) => {
        const type = previousTypes.get(id);
        return type !== undefined && findEntryViolation(id, previousRead.capabilitiesObj[id], type) === null;
    });
}
