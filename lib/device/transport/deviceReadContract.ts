/**
 * Validate each Homey capability at the device transport boundary. A bad value,
 * missing entry or source date rejects that field only. Keep its last accepted
 * reading with its original date, or withhold it until its first valid reading;
 * accept independent valid fields in the same payload. This applies to vendor
 * sources before conversion as well as standard Homey capabilities.
 *
 * Only an unreadable envelope (no capability list or value map) ignores the
 * whole read. Never turn a field-validation failure into loss of device support.
 * See lib/device/AGENTS.md for observation and dependent-control rules.
 */
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

export type DeviceReadContractViolation =
    | { reason: 'missing_capability_list' }
    | { reason: 'missing_capability_values' }
    | { reason: 'missing_capability_entry'; capabilityId: string }
    | { reason: 'unexpected_value'; capabilityId: string }
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
        ...resolveModelCapabilityTypes(device, device.capabilities ?? []),
        ...getDeviceAdapter(device).readRules(device),
    };
    const type = types[capabilityId];
    if (type === undefined || !isModelValue(capabilityId, value, type)) return device;
    return {
        ...device,
        capabilitiesObj: {
            ...device.capabilitiesObj,
            [capabilityId]: { ...device.capabilitiesObj?.[capabilityId], value, lastUpdated: observedAtMs },
        },
    };
}

/** The raw source fields this device's model and adapter actually read. */
function findRawCapabilityViolations(device: HomeyDeviceLike): CapabilityViolation[] {
    const capabilities = device.capabilities ?? [];
    const values = device.capabilitiesObj ?? {};
    const integrationTypes = getDeviceAdapter(device).readRules(device);
    const types = { ...resolveModelCapabilityTypes(device, capabilities), ...integrationTypes };
    const readIds = new Set([...capabilities,
        ...Object.keys(integrationTypes).filter((id) => Object.hasOwn(values, id))]);
    return [...readIds].flatMap((capabilityId) => {
        const type = types[capabilityId];
        if (type === undefined) return [];
        const violation = findEntryViolation(capabilityId, values[capabilityId], type);
        return violation ? [violation] : [];
    });
}

export type DeviceCapabilityResolution = {
    device: HomeyDeviceLike;
    violations: readonly CapabilityViolation[];
    retainedCapabilityIds: readonly string[];
    withheldCapabilityIds: readonly string[];
};

/** A rejected scalar observation does not erase a real supported write operation. */
function resolveReadDescriptorIds(device: HomeyDeviceLike): Set<string> {
    const values = Object.fromEntries(Object.entries(device.capabilitiesObj ?? {}).flatMap(([id, entry]) => (
        entry === undefined ? [] : [[id, entry]]
    )));
    const overlay = applyNativeEvWiringOverlay(device, device.capabilities ?? [], values);
    return new Set([
        'onoff', 'evcharger_charging', 'measure_temperature', 'target_temperature', 'target_power', 'target_power_mode',
        ...getDeviceAdapter(device).nativeCurrentControls.map((control) => control.capabilityId),
        ...(overlay.binaryWriteCapabilityId ? [overlay.binaryWriteCapabilityId] : []),
    ]);
}

/**
 * Reject fields independently, without refreshing retained observations. A
 * rejected control prerequisite cannot enable an alternative control path.
 */
export function withholdInvalidModelCapabilities(
    device: HomeyDeviceLike,
    previousRead?: HomeyDeviceLike,
): DeviceCapabilityResolution {
    const violations = findRawCapabilityViolations(device);
    const types = {
        ...resolveModelCapabilityTypes(device, device.capabilities ?? []),
        ...getDeviceAdapter(device).readRules(device),
    };
    const retained = violations.flatMap(({ capabilityId }) => {
        const entry = previousRead?.capabilitiesObj?.[capabilityId];
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
    const descriptorIds = resolveReadDescriptorIds(device);
    if (withheld.has('evcharger_charging') && resolveDeviceClassKey(device) === 'evcharger') {
        descriptorIds.delete('onoff');
    }
    const descriptors = [...withheld].flatMap((id) => {
        const entry = device.capabilitiesObj?.[id];
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
            capabilities: device.capabilities?.filter((id) => !withheld.has(id) || descriptorIds.has(id)),
            capabilitiesObj: Object.fromEntries([
                ...Object.entries(device.capabilitiesObj ?? {})
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
    if (!Array.isArray(capabilities) || !capabilities.every((id) => typeof id === 'string')) {
        return { reason: 'missing_capability_list' };
    }
    if (!isUnknownRecord(capabilitiesObj)) return { reason: 'missing_capability_values' };
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
    if (!isModelValue(capabilityId, entry.value, type)) return { reason: 'unexpected_value', capabilityId };
    if (toCapabilityTimestampMs(entry.lastUpdated) === undefined) return { reason: 'missing_stamp', capabilityId };
    return null;
}

export type DeviceReadSource = 'device_fetch' | 'device_update';

/** The two levels an ignored read is said at. */
export type DeviceReadContractEmitter = {
    warn: (payload: Record<string, unknown>) => void;
    info: (payload: Record<string, unknown>) => void;
};

// The last violation or withheld set said per device, per transport, so a
// device that stays non-conforming is named once rather than on every refresh
// and update. Cleared when it conforms again, which is said too: an ignored
// read or a withheld capability is a gap in what PELS knows, and the log is
// where an owner's support session finds its start and end. Keyed by the
// transport's owner so two transports (and two tests) never share what was
// said.
const lastViolationSignatureByOwner = new WeakMap<object, Map<string, string>>();

const violationSignatures = (owner: object): Map<string, string> => {
    const existing = lastViolationSignatureByOwner.get(owner);
    if (existing) return existing;
    const created = new Map<string, string>();
    lastViolationSignatureByOwner.set(owner, created);
    return created;
};

/** Resolve a read before producers, parsing or tracking can consume any values. */
export function resolveDeviceRead(
    owner: object,
    device: HomeyDeviceLike,
    source: DeviceReadSource,
    emitter: DeviceReadContractEmitter,
    previousRead?: HomeyDeviceLike,
): HomeyDeviceLike | null {
    const deviceId = typeof device.id === 'string' ? device.id : '';
    const signatures = violationSignatures(owner);
    const envelope = findEnvelopeViolation(device);
    if (envelope) {
        if (claimSignature(signatures, deviceId, envelope)) {
            emitter.warn({ event: 'device_read_ignored', deviceId, deviceName: device.name, source, ...envelope });
        }
        return null;
    }
    const resolution = withholdInvalidModelCapabilities(device, previousRead);
    const { violations, retainedCapabilityIds, withheldCapabilityIds } = resolution;
    if (violations.length === 0) {
        if (signatures.delete(deviceId)) {
            emitter.info({ event: 'device_read_conforming_again', deviceId, deviceName: device.name, source });
        }
    } else if (claimSignature(signatures, deviceId, { violations, retainedCapabilityIds, withheldCapabilityIds })) {
        emitter.info({
            event: 'device_capabilities_withheld', deviceId, deviceName: device.name, source,
            capabilityIds: violations.map(({ capabilityId }) => capabilityId),
            violations, retainedCapabilityIds, withheldCapabilityIds,
        });
    }
    return resolution.device;
}

function findEnvelopeViolation(device: HomeyDeviceLike): DeviceReadContractViolation | null {
    if (!Array.isArray(device.capabilities) || !device.capabilities.every((id) => typeof id === 'string')) {
        return { reason: 'missing_capability_list' };
    }
    if (!isUnknownRecord(device.capabilitiesObj)) return { reason: 'missing_capability_values' };
    return null;
}

/** Record what is said about a device; true when it differs from what was said last. */
function claimSignature(signatures: Map<string, string>, deviceId: string, said: object): boolean {
    const signature = JSON.stringify(said);
    if (signatures.get(deviceId) === signature) return false;
    signatures.set(deviceId, signature);
    return true;
}
