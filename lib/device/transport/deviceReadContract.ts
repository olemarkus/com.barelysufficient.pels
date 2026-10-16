/**
 * The Homey device-read contract, checked at the SDK boundary before anything
 * reads the payload.
 *
 * Owner ruling (2026-09-23): PELS never uses partial data from the SDK. A device
 * read — a full `manager/devices` fetch or a realtime `device.update` — must
 * carry the device's capability list and, for every capability of PELS's device
 * model it declares, a value of the model's type and the time Homey observed it
 * (`lastUpdated`). Every observation PELS keeps is dated by its source; a value
 * with no date cannot be ordered against the others, so it is not a reading.
 * A read that does not is IGNORED: nothing is parsed, nothing is emitted, and
 * the device's previous entry stands exactly as if the read had not happened.
 * There is no "incomplete" state downstream; a non-conforming read is a no-op,
 * the same treatment a transient read failure gets.
 *
 * The model is PELS's, not the vendor's, and the check runs on the model. A
 * vendor device PELS converts is converted first — Zaptec's `charge_mode`,
 * car-connected alarm and charging button become `evcharger_charging_state` and
 * `evcharger_charging` (`applyNativeEvWiringOverlay`) — and the converted values
 * are what must conform. A charger reporting `evcharger_charging_state` natively
 * must report a member of the Homey plug-state enum. The model is also scoped
 * by what PELS reads from the device's role: a car is read only for its plug
 * state and state of charge, state of charge only from a charger or a home
 * battery, temperature only from a device with both a measurement and a
 * target, and nothing at all from a class PELS does not admit. A driver may
 * declare capabilities that do not fit PELS's model of its device and never
 * report them (seen on a production hub); those are not PELS's business.
 * Capabilities outside the model — buttons, camera commands — are never read,
 * so their routine `null` values are none of this contract's business.
 *
 * Owner ruling (2026-10-16): a `null` value rejects that capability, not the
 * read. Device apps do set a model capability to `null` (Stiebel Eltron Heat
 * Pumps clears one whenever a Modbus register reads as unavailable, and adds
 * `measure_power` that stays `null` without its community registers), and
 * ignoring the whole read for it hid an otherwise readable heat pump. A `null`
 * is not a value, and PELS invents none for it: the capability is withheld
 * from that read (`withholdNullModelCapabilities`), so the device reads as if
 * it did not declare it, until a read reports a value again. A `null`
 * `meter_power` beside a reported `measure_power` leaves the device metered,
 * and a `null` temperature leaves it without its temperature facet. A vendor device an
 * adapter converts or reads more of stays all-or-nothing.
 */
import { isUnknownRecord, type HomeyDeviceLike } from '../../utils/types';
import { isEvCarDeviceClass } from '../evCarDeviceClass';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
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
    measure_battery: 'number',
    measure_soc_usable: 'number',
    measure_soc_level: 'number',
    thermostat_mode: 'string',
    target_power: 'number',
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
    measure_battery: 'number',
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
 * readable.
 *
 * Its claim capability is outside this all-or-nothing contract, though its
 * value and stamp ARE read: they are resolved at their own boundary
 * (`resolveParsedClaim`, `homeBatteryObservation.ts`), where a missing or
 * malformed claim keeps the last accepted one or reads as unreported. Failing
 * the whole read on it instead would hide the battery's power and state of
 * charge while leaving its claim exactly as it was.
 */
const STEPPED_ONLY_CAPABILITY_IDS: ReadonlySet<string> = new Set(['target_power']);

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

/**
 * The model capabilities `device` declares with a `null` value. Only a device
 * read as Homey reports it: a vendor device an adapter converts or reads more
 * of (Tesla, Easee, Zaptec) chooses its control path from what it declares, so
 * it stays all-or-nothing.
 */
function findNullModelCapabilityIds(device: HomeyDeviceLike): ReadonlySet<string> {
    const { capabilities, capabilitiesObj } = device;
    if (!Array.isArray(capabilities) || !isUnknownRecord(capabilitiesObj)) return new Set();
    if (getDeviceAdapter(device) !== standardDeviceAdapter) return new Set();
    const modelTypes = resolveModelCapabilityTypes(device, capabilities);
    return new Set(capabilities.filter((capabilityId) => {
        if (modelTypes[capabilityId] === undefined) return false;
        const entry: unknown = capabilitiesObj[capabilityId];
        return isUnknownRecord(entry) && entry.value === null;
    }));
}

/**
 * The capabilities withheld beside the `null` ones. A charger's on/off handle is
 * `evcharger_charging` (`getControlCapabilityId`). Withholding it alone would
 * leave a declared `onoff` to be picked as the handle for this read, and on some
 * chargers `onoff` disables the charger rather than pausing the session. So the
 * charger has no on/off handle until `evcharger_charging` reports a value again.
 */
function findCapabilityIdsWithheldWithNull(
    device: HomeyDeviceLike,
    nullCapabilityIds: ReadonlySet<string>,
): ReadonlySet<string> {
    return nullCapabilityIds.has('evcharger_charging')
        && device.capabilities?.includes('onoff') === true
        && resolveDeviceClassKey(device) === 'evcharger'
        ? new Set(['onoff'])
        : new Set();
}

const withNullCompanions = (
    device: HomeyDeviceLike,
    nullCapabilityIds: ReadonlySet<string>,
): ReadonlySet<string> => new Set([
    ...nullCapabilityIds, ...findCapabilityIdsWithheldWithNull(device, nullCapabilityIds),
]);

export type NullModelCapabilityResolution = {
    device: HomeyDeviceLike;
    /** Declared `null`: read as not declared. */
    withheldCapabilityIds: readonly string[];
};

/**
 * `device` with each model capability it declares as `null` withheld: dropped
 * from both the capability list and the values, so everything downstream reads
 * the device as not declaring it. Nothing stands in for it; the capability is
 * back with the first read that reports a value.
 */
export function withholdNullModelCapabilities(device: HomeyDeviceLike): NullModelCapabilityResolution {
    return withholdCapabilities(device, withNullCompanions(device, findNullModelCapabilityIds(device)));
}

function withholdCapabilities(
    device: HomeyDeviceLike,
    withheld: ReadonlySet<string>,
): NullModelCapabilityResolution {
    if (withheld.size === 0) return { device, withheldCapabilityIds: [] };
    return {
        device: {
            ...device,
            capabilities: (device.capabilities ?? []).filter((capabilityId) => !withheld.has(capabilityId)),
            capabilitiesObj: Object.fromEntries(Object.entries(device.capabilitiesObj ?? {})
                .filter(([capabilityId]) => !withheld.has(capabilityId))),
        },
        withheldCapabilityIds: [...withheld],
    };
}

/** The first way `device` breaks the contract, or `null` for a conforming read. */
export function findDeviceReadContractViolation(device: HomeyDeviceLike): DeviceReadContractViolation | null {
    return findViolation(device, new Set());
}

/**
 * The contract check, with a `null` value tolerated on the capabilities
 * `withholdNullModelCapabilities` withholds. It runs on the read as declared, so
 * withholding one member of the temperature pair never takes the other out of
 * the model it is checked against.
 */
function findViolation(
    device: HomeyDeviceLike,
    nullTolerated: ReadonlySet<string>,
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
    // Session evidence also reads vendor entries present in capabilitiesObj;
    // validate those before it can retain any part of this device read.
    const readCapabilities = new Set([...model.capabilities,
        ...Object.keys(integrationTypes).filter((id) => Object.hasOwn(capabilitiesObj, id))]);
    const noEvProjection = getDeviceAdapter(device).retainsPlugObservation(device);
    for (const capabilityId of readCapabilities) {
        // These complete vendor reads are valid, but cannot assert a new EV
        // plug observation. Session ingestion still needs them to revoke control.
        if (noEvProjection && capabilityId === 'evcharger_charging_state') continue;
        const type = modelTypes[capabilityId];
        if (type === undefined) continue;
        const violation = findEntryViolation(capabilityId, model.capabilityObj[capabilityId], type, nullTolerated);
        if (violation !== null) return violation;
    }
    return null;
}

/** How one model capability's entry breaks the contract, or `null` if it does not. */
function findEntryViolation(
    capabilityId: string,
    entry: unknown,
    type: ModelValueType,
    nullTolerated: ReadonlySet<string>,
): DeviceReadContractViolation | null {
    if (!isUnknownRecord(entry)) return { reason: 'missing_capability_entry', capabilityId };
    if (entry.value === null && nullTolerated.has(capabilityId)) return null;
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

/**
 * Check `device` against the contract and say so when it fails or a `null`
 * capability is withheld. `null` means the read is ignored: the caller must not
 * parse it, merge it, or let any of it reach state. Otherwise the caller reads
 * the returned device, never the payload it passed in.
 */
export function resolveDeviceRead(
    owner: object,
    device: HomeyDeviceLike,
    source: DeviceReadSource,
    emitter: DeviceReadContractEmitter,
): HomeyDeviceLike | null {
    const deviceId = typeof device.id === 'string' ? device.id : '';
    const signatures = violationSignatures(owner);
    const nullCapabilityIds = findNullModelCapabilityIds(device);
    const violation = findViolation(device, nullCapabilityIds);
    if (violation !== null) {
        if (claimSignature(signatures, deviceId, { violation })) {
            emitter.warn({ event: 'device_read_ignored', deviceId, deviceName: device.name, source, ...violation });
        }
        return null;
    }
    const companionIds = [...findCapabilityIdsWithheldWithNull(device, nullCapabilityIds)];
    const { device: read, withheldCapabilityIds } = withholdCapabilities(
        device, withNullCompanions(device, nullCapabilityIds),
    );
    if (withheldCapabilityIds.length === 0) {
        if (signatures.delete(deviceId)) {
            emitter.info({ event: 'device_read_conforming_again', deviceId, deviceName: device.name, source });
        }
    } else if (claimSignature(signatures, deviceId, { withheldCapabilityIds })) {
        emitter.info({
            event: 'device_capabilities_withheld',
            deviceId,
            deviceName: device.name,
            source,
            reason: 'null_value',
            capabilityIds: [...nullCapabilityIds],
            // Withheld with a null charging capability, though it holds a value.
            ...(companionIds.length > 0 ? { withheldWithNullCapabilityIds: companionIds } : {}),
        });
    }
    return read;
}

/** Record what is said about a device; true when it differs from what was said last. */
function claimSignature(signatures: Map<string, string>, deviceId: string, said: object): boolean {
    const signature = JSON.stringify(said);
    if (signatures.get(deviceId) === signature) return false;
    signatures.set(deviceId, signature);
    return true;
}
