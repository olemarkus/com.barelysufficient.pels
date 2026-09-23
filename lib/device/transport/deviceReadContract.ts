/**
 * The Homey device-read contract, checked at the SDK boundary before anything
 * reads the payload.
 *
 * Owner ruling (2026-09-23): PELS never uses partial data from the SDK. A device
 * read — a full `manager/devices` fetch or a realtime `device.update` — must
 * carry the device's capability list and, for every capability of PELS's device
 * model it declares, a value of the model's type.
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
 * report them (seen on a production hub); those are not PELS's business. A
 * capability PELS does read either has a value or the device is not yet
 * admissible — Homey does not revert a set value to `null`. Capabilities
 * outside the model — buttons, camera commands — are never read, so their
 * routine `null` values are none of this contract's business.
 */
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceCapabilityMap } from '../managerControl';
import { applyNativeEvWiringOverlay } from '../nativeEvWiring';
import { isEvChargingState } from '../../../packages/shared-domain/src/evPlugState';
import { resolveDeviceClassKey } from './managerHelpers';

type ModelValueType = 'boolean' | 'number' | 'string';

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
 * A class `car` never survives parse: PELS's whole model of a car is what the
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

const isCar = (device: HomeyDeviceLike): boolean => (
    typeof device.class === 'string' && device.class.trim().toLowerCase() === 'car'
);

const NO_MODEL_CAPABILITIES: Readonly<Record<string, ModelValueType>> = {};

/**
 * The capabilities PELS reads from this device, by its role. A device whose
 * class PELS does not admit (a camera, a light, a sensor) is never parsed, so
 * nothing about it is PELS's to check.
 */
function resolveModelCapabilityTypes(
    device: HomeyDeviceLike,
    capabilities: readonly string[],
): Readonly<Record<string, ModelValueType>> {
    if (isCar(device)) return CAR_MODEL_CAPABILITY_TYPES;
    const classKey = resolveDeviceClassKey(device);
    if (classKey === null) return NO_MODEL_CAPABILITIES;
    const withTemperatureFacet = readsTemperatureFacet(capabilities);
    const withStateOfCharge = STATE_OF_CHARGE_CLASS_KEYS.has(classKey);
    return Object.fromEntries(Object.entries(DEVICE_MODEL_CAPABILITY_TYPES).filter(([capabilityId]) => (
        (withTemperatureFacet || !TEMPERATURE_FACET_CAPABILITY_IDS.has(capabilityId))
        && (withStateOfCharge || !STATE_OF_CHARGE_CAPABILITY_IDS.has(capabilityId))
    )));
}

export type DeviceReadContractViolation =
    | { reason: 'missing_capability_list' }
    | { reason: 'missing_capability_values' }
    | { reason: 'missing_capability_entry'; capabilityId: string }
    | { reason: 'unexpected_value'; capabilityId: string };

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasModelType = (value: unknown, type: ModelValueType): boolean => {
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
};

// A model value beyond its primitive type: a plug state is a closed enum.
const PLUG_STATE_CAPABILITY_IDS = new Set(['evcharger_charging_state', 'ev_charging_state']);
const isModelValue = (capabilityId: string, value: unknown, type: ModelValueType): boolean => (
    PLUG_STATE_CAPABILITY_IDS.has(capabilityId) ? isEvChargingState(value) : hasModelType(value, type)
);

/** The first way `device` breaks the contract, or `null` for a conforming read. */
export function findDeviceReadContractViolation(device: HomeyDeviceLike): DeviceReadContractViolation | null {
    const { capabilities, capabilitiesObj } = device;
    if (!Array.isArray(capabilities) || !capabilities.every((id) => typeof id === 'string')) {
        return { reason: 'missing_capability_list' };
    }
    if (!isRecord(capabilitiesObj)) return { reason: 'missing_capability_values' };
    // Convert to the model first; only then validate.
    const model = applyNativeEvWiringOverlay({
        device,
        capabilities,
        capabilityObj: capabilitiesObj as DeviceCapabilityMap,
    });
    const modelTypes = resolveModelCapabilityTypes(device, model.capabilities);
    for (const capabilityId of model.capabilities) {
        const type = modelTypes[capabilityId];
        if (type === undefined) continue;
        const entry: unknown = model.capabilityObj[capabilityId];
        if (!isRecord(entry)) return { reason: 'missing_capability_entry', capabilityId };
        if (!isModelValue(capabilityId, entry.value, type)) return { reason: 'unexpected_value', capabilityId };
    }
    return null;
}

export type DeviceReadSource = 'device_fetch' | 'device_update';

/** The two levels an ignored read is said at. */
export type DeviceReadContractEmitter = {
    warn: (payload: Record<string, unknown>) => void;
    info: (payload: Record<string, unknown>) => void;
};

// The last violation said per device, per transport, so a device that stays
// non-conforming is named once rather than on every refresh and update. Cleared
// when it conforms again, which is said too: an ignored read is a gap in what
// PELS knows, and the log is where an owner's support session finds its start
// and end. Keyed by the transport's owner so two transports (and two tests)
// never share what was said.
const lastViolationSignatureByOwner = new WeakMap<object, Map<string, string>>();

const violationSignatures = (owner: object): Map<string, string> => {
    const existing = lastViolationSignatureByOwner.get(owner);
    if (existing) return existing;
    const created = new Map<string, string>();
    lastViolationSignatureByOwner.set(owner, created);
    return created;
};

/**
 * Check `device` against the contract and say so when it fails. True means the
 * read is ignored: the caller must not parse it, merge it, or let any of it
 * reach state.
 */
export function isIgnoredDeviceRead(
    owner: object,
    device: HomeyDeviceLike,
    source: DeviceReadSource,
    emitter: DeviceReadContractEmitter,
): boolean {
    const deviceId = typeof device.id === 'string' ? device.id : '';
    const signatures = violationSignatures(owner);
    const violation = findDeviceReadContractViolation(device);
    if (violation === null) {
        if (signatures.delete(deviceId)) {
            emitter.info({ event: 'device_read_conforming_again', deviceId, deviceName: device.name, source });
        }
        return false;
    }
    const signature = JSON.stringify(violation);
    if (signatures.get(deviceId) !== signature) {
        signatures.set(deviceId, signature);
        emitter.warn({ event: 'device_read_ignored', deviceId, deviceName: device.name, source, ...violation });
    }
    return true;
}
