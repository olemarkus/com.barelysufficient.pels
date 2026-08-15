/**
 * Boundary that turns a raw Homey device payload into a resolved car
 * observation for the EV car-link probe.
 *
 * The rule this file exists to enforce: a capability that is missing or
 * unreadable is an ABSENT observation, never a new value. Such a read is
 * skipped and the previous value retained, and a car with no readable plug
 * state is not tracked at all — so no `undefined`/`null` "unknown" is ever
 * stored here or handed to the correlation domain, which takes only resolved
 * values (root `AGENTS.md` -> "Validation belongs at the boundary").
 *
 * Official Homey capabilities only: `ev_charging_state` and `measure_battery`.
 */
import type { EvChargingState } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../utils/types';
import { isEvChargingState } from '../../packages/shared-domain/src/evPlugState';
import { toCapabilityTimestampMs } from './managerControl';
import { normalizeStateOfChargePercent } from './transport/stateOfCharge';

/**
 * The capabilities a car must publish for an association to be possible at all.
 * A car missing `ev_charging_state` is never even tracked (`readCarDevice`
 * returns nothing without a resolved plug state), and one missing
 * `measure_battery` can associate but has no battery level to contribute — so
 * offering either in the charger's car picker would be offering a car that can
 * never do the job. Exported so the picker filters on exactly what this module
 * reads.
 */
export const EV_CAR_REQUIRED_CAPABILITY_IDS = ['ev_charging_state', 'measure_battery'] as const;

export type CarObservation = {
    name: string;
    /** Always resolved: a car with no readable plug state is never tracked, so
     *  no "unknown" plug state exists anywhere downstream. */
    state: EvChargingState;
    stateAtMs: number;
    /** ABSENT until the car has reported a valid charge at least once. */
    socPct?: number;
    socAtMs: number;
};

export type CarReading = {
    deviceId: string;
    name: string;
    /** `undefined` = the capability was absent or unreadable, NOT "unplugged". */
    state: EvChargingState | undefined;
    stateAtMs: number;
    /** `undefined` = absent or out of range, NOT "empty battery". */
    socPct: number | undefined;
    socAtMs: number;
};

/**
 * A Homey car read is either usable capability evidence or an explicit device
 * outage. The latter is not a plug observation: cached capability values remain
 * present in Homey's payload while the integration is offline, but PELS cannot
 * stand behind them until the device becomes available again.
 */
export type CarDeviceRead =
    | { kind: 'unavailable'; deviceId: string; name: string }
    | { kind: 'observed'; reading: CarReading };

/** Identity gate: a usable id on a class `car` device, or nothing. */
export const readCarIdentity = (device: HomeyDeviceLike): { deviceId: string; name: string } | null => {
    if (typeof device.class !== 'string' || device.class.trim().toLowerCase() !== 'car') return null;
    const deviceId = device.id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
    return { deviceId, name: typeof device.name === 'string' ? device.name : deviceId };
};

/**
 * Tolerance for a capability timestamp that legitimately runs slightly ahead of
 * our own clock. Anything beyond this is not a real observation time.
 */
const CAPABILITY_CLOCK_SKEW_MS = 60_000;

/**
 * Resolve a capability's observation time, rejecting a corrupt FUTURE value.
 *
 * `lastUpdated` is finite-gated but otherwise unbounded, and `mergeObservation`
 * keeps whichever reading is newer. A far-future timestamp accepted here would
 * therefore beat every subsequent honest report for that capability, silently
 * disabling plug-edge and charge observation for that car indefinitely. Falling
 * back to arrival time keeps the reading usable and self-corrects on the next
 * report, which is the conservative direction.
 */
const resolveObservedAtMs = (
    raw: string | number | Date | null | undefined,
    arrivedAtMs: number,
): number => {
    const parsed = toCapabilityTimestampMs(raw);
    if (parsed === undefined) return arrivedAtMs;
    return parsed > arrivedAtMs + CAPABILITY_CLOCK_SKEW_MS ? arrivedAtMs : parsed;
};

export const readCarDevice = (device: HomeyDeviceLike, arrivedAtMs: number): CarDeviceRead | null => {
    const identity = readCarIdentity(device);
    if (!identity) return null;
    if (device.available === false) return { kind: 'unavailable', ...identity };
    const stateCapability = device.capabilitiesObj?.ev_charging_state;
    const socCapability = device.capabilitiesObj?.measure_battery;
    const rawState = stateCapability?.value;
    return {
        kind: 'observed',
        reading: {
            ...identity,
            state: isEvChargingState(rawState) ? rawState : undefined,
            stateAtMs: resolveObservedAtMs(stateCapability?.lastUpdated, arrivedAtMs),
            socPct: normalizeStateOfChargePercent(socCapability?.value),
            socAtMs: resolveObservedAtMs(socCapability?.lastUpdated, arrivedAtMs),
        },
    };
};

/**
 * Fold a fresh reading over the held observation, per capability.
 *
 * Returns `null` when the car has never had a readable plug state: it is then
 * simply not tracked. That is the whole point — an unknown is dropped at this
 * boundary rather than stored and propagated inward as `undefined`.
 */
export const mergeCarObservation = (
    previous: CarObservation | undefined,
    reading: CarReading,
): CarObservation | null => {
    const plug = mergeObservation({
        previousValue: previous?.state,
        previousAtMs: previous?.stateAtMs ?? 0,
        nextValue: reading.state,
        nextAtMs: reading.stateAtMs,
        isReadable: (value) => value !== undefined,
    });
    if (plug.value === undefined) return null;
    const charge = mergeObservation({
        previousValue: previous?.socPct,
        previousAtMs: previous?.socAtMs ?? 0,
        nextValue: reading.socPct,
        nextAtMs: reading.socAtMs,
        isReadable: (value) => value !== undefined,
    });
    return {
        name: reading.name,
        state: plug.value,
        stateAtMs: plug.atMs,
        ...(charge.value === undefined ? {} : { socPct: charge.value }),
        socAtMs: charge.atMs,
    };
};

/**
 * Merge one capability's reading over what we hold. An unreadable value is an
 * ABSENT observation, not a new one: overwriting with it would erase the last
 * trusted plug state, and the following genuine transition would then be
 * compared against `undefined` and produce no edge at all — the session could
 * neither link nor clear. An older reading is likewise dropped (a fetch can
 * start before a realtime update and land after it).
 *
 * Where a device supplies no capability timestamp the arrival time stands in,
 * which cannot distinguish those two cases — the honest limit of the data.
 */
const mergeObservation = <T>(params: {
    previousValue: T;
    previousAtMs: number;
    nextValue: T;
    nextAtMs: number;
    isReadable: (value: T) => boolean;
}): { value: T; atMs: number } => {
    const { previousValue, previousAtMs, nextValue, nextAtMs, isReadable } = params;
    if (!isReadable(nextValue)) return { value: previousValue, atMs: previousAtMs };
    if (isReadable(previousValue) && nextAtMs < previousAtMs) {
        return { value: previousValue, atMs: previousAtMs };
    }
    return { value: nextValue, atMs: nextAtMs };
};

/**
 * Apply a single realtime capability event to a car we already track.
 *
 * Returns `null` for "nothing changed" — an unrelated capability, an unreadable
 * value (absent observation, keep what we hold), an event older than the value
 * it would replace, or a no-op repeat. The caller only acts on a non-null
 * result, so the same skip-and-keep discipline as the full-payload path applies.
 *
 * Requires an existing observation: a car is only tracked once it has a readable
 * plug state, so this can never introduce an unknown.
 */
export const applyCarCapability = (
    previous: CarObservation,
    params: { capabilityId: string; value: unknown; atMs: number },
): CarObservation | null => {
    const { capabilityId, value, atMs } = params;
    if (capabilityId === 'ev_charging_state') {
        if (!isEvChargingState(value)) return null;
        if (atMs < previous.stateAtMs || value === previous.state) return null;
        return { ...previous, state: value, stateAtMs: atMs };
    }
    if (capabilityId === 'measure_battery') {
        const socPct = normalizeStateOfChargePercent(value);
        if (socPct === undefined) return null;
        if (atMs < previous.socAtMs || socPct === previous.socPct) return null;
        return { ...previous, socPct, socAtMs: atMs };
    }
    return null;
};
