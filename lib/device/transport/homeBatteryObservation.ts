/**
 * The home-battery clusters on the transport snapshot: the control surface
 * (descriptor) and the signed power and claim value (observed). Resolved at
 * parse for a device whose class key is `battery`, kept current by realtime
 * capability events, and carried across a full refresh.
 *
 * Observation only, and the battery control owner's read of it
 * (`toBatteryControlRead`). Nothing here commands a battery.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type {
    HomeBatteryClaimObservation,
    HomeBatteryControlSurface,
    HomeBatteryDescriptorFields,
    HomeBatteryDescriptorProbe,
    HomeBatteryLevelObservation,
    HomeBatteryPowerObservation,
} from '../../../packages/contracts/src/types';
import type { BatteryControlRead, HomeBatteryClaimRead } from '../../ports/batteryControlOwner';
import { resolveBatteryControlSurface } from '../batteryControlWiring';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import type { ObservationCursor, ObservedDeviceStateEvent } from './managerRealtimeHandlers';
import { normalizeStateOfChargePercent } from './stateOfCharge';
import { HOME_BATTERY_CLASS_KEY } from '../../../packages/shared-domain/src/batteryOrSolarRole';

const MEASURE_POWER_CAPABILITY_ID = 'measure_power';
const MEASURE_BATTERY_CAPABILITY_ID = 'measure_battery';

/**
 * Type guard: the snapshot is a home battery. Presence is the kind: the parse
 * attaches `homeBattery` to every device whose class key is `battery`, and to
 * nothing else. Whether PELS could drive it is `homeBattery.controlSurface.kind`.
 * Device-layer only: nothing outside the transport reads the cluster yet.
 */
export const isHomeBatterySnapshot = <T extends HomeBatteryDescriptorProbe>(
    snapshot: T,
): snapshot is T & HomeBatteryDescriptorFields => (
    snapshot.homeBattery !== undefined
);

/** Finite signed watts: the sign is the battery's direction, so it is kept. */
const readSignedPowerW = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const readClaimValue = (value: unknown): string | undefined => (
    typeof value === 'string' && value.length > 0 ? value : undefined
);

/**
 * The draw view of a battery's signed reading, in kW: what it takes from the
 * house. A battery that discharges or idles draws nothing, so a reading at or
 * below 0 W is 0 kW — a measurement, not an absence.
 */
const toHomeBatteryDrawKw = (signedW: number): number => Math.max(0, signedW) / 1000;

/**
 * The draw-view fields for a parsed battery reading at or below 0 W, which the
 * device-draw resolver drops as malformed. Dated by the reading, like any
 * other `measure_power` observation. A positive reading is the resolver's.
 */
const resolveDischargingDrawView = (
    snapshot: TransportDeviceSnapshot,
    batteryPower: HomeBatteryPowerObservation,
): Partial<TransportDeviceSnapshot> => {
    if (batteryPower.signedW > 0) return {};
    const { observedAtMs } = batteryPower;
    const lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observedAtMs);
    return {
        measuredPowerKw: 0,
        measuredPowerObservedAtMs: observedAtMs,
        measuredPowerReading: { kind: 'instantaneous', powerKw: 0, observedAtMs },
        measuredPowerSource: 'measure_power',
        lastFreshDataMs,
        lastUpdated: lastFreshDataMs,
    };
};

/**
 * The battery's own charge level from this read, or the carried one when the
 * read has none (a missing sample is not a new observation).
 */
const resolveParsedLevel = (
    capabilities: readonly string[],
    capabilityObj: DeviceCapabilityMap,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): HomeBatteryLevelObservation | undefined => {
    const entry = capabilities.includes(MEASURE_BATTERY_CAPABILITY_ID)
        ? capabilityObj[MEASURE_BATTERY_CAPABILITY_ID]
        : undefined;
    const percent = normalizeStateOfChargePercent(entry?.value);
    const observedAtMs = toCapabilityTimestampMs(entry?.lastUpdated);
    if (percent === undefined || observedAtMs === undefined) return previousSnapshot?.batteryLevel;
    return { percent, observedAtMs };
};

/**
 * The claim carried from the previous snapshot: only while it claimed through
 * the same capability. A stored claim always belongs to its own snapshot's
 * surface (the parse reads the surface's capability, and the realtime handler
 * stores only an event on it), so comparing the surfaces keeps a reclassified
 * battery from carrying a claim read off a capability it no longer claims
 * through.
 */
const resolveCarriedClaim = (
    capabilityId: string,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): HomeBatteryClaimObservation | undefined => {
    const previousSurface = previousSnapshot?.homeBattery?.controlSurface;
    return previousSurface?.kind === 'setpoint' && previousSurface.claim.capabilityId === capabilityId
        ? previousSnapshot?.batteryClaim
        : undefined;
};

/**
 * How far a pulled claim's Homey stamp may fall behind the carried claim's
 * before the pull is read as older. A realtime claim is dated on arrival, a
 * little after Homey stamped the change, so a pull of a later change can carry
 * a stamp a moment earlier than the realtime claim it replaces.
 */
const CLAIM_STAMP_SKEW_MS = 5_000;

/**
 * The claim this read leaves the battery with. A different reported value
 * wins unless Homey stamped it more than `CLAIM_STAMP_SKEW_MS` before the
 * carried claim: such a pull was read before the change the carried claim
 * reports (the realtime echo of PELS's own claim, typically), and taking it
 * would undo that change until the next read. The same value keeps the later
 * stamp. A read with no value keeps the carried one (a missing sample is not a
 * new observation).
 */
const resolveParsedClaim = (
    controlSurface: HomeBatteryControlSurface,
    capabilityObj: DeviceCapabilityMap,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): HomeBatteryClaimObservation | undefined => {
    if (controlSurface.kind !== 'setpoint') return undefined;
    const { capabilityId } = controlSurface.claim;
    const kept = resolveCarriedClaim(capabilityId, previousSnapshot);
    const entry = capabilityObj[capabilityId];
    const value = readClaimValue(entry?.value);
    const observedAtMs = toCapabilityTimestampMs(entry?.lastUpdated);
    if (value === undefined || observedAtMs === undefined) return kept;
    if (kept?.value === value) return { value, observedAtMs: Math.max(kept.observedAtMs, observedAtMs) };
    if (kept !== undefined && kept.observedAtMs - observedAtMs > CLAIM_STAMP_SKEW_MS) return kept;
    return { value, observedAtMs };
};

/**
 * A transport snapshot as the battery control owner reads it
 * (`BatteryControlRead`): `undefined` is a device not observed (yet), a
 * snapshot without the home-battery cluster is no battery, and a battery
 * without a setpoint surface is one PELS can only observe. A setpoint battery
 * that has not reported its claim value reads `unreported`.
 */
export const toBatteryControlRead = (snapshot: TransportDeviceSnapshot | undefined): BatteryControlRead => {
    if (snapshot === undefined) return { kind: 'unobserved' };
    if (!isHomeBatterySnapshot(snapshot)) return { kind: 'not_battery' };
    const surface = snapshot.homeBattery.controlSurface;
    if (surface.kind !== 'setpoint') return { kind: 'observe_only' };
    // No claim cluster is a battery that has reported no claim value yet.
    const claim: HomeBatteryClaimRead = snapshot.batteryClaim === undefined
        ? { kind: 'unreported' }
        : snapshot.batteryClaim;
    return { kind: 'setpoint', surface, claim };
};

/**
 * The parsed snapshot with its home-battery clusters: unchanged for anything
 * but a battery. `overlay` is the parse's overlaid capability view; a
 * battery's `target_power` there is the device's own, because the stepped
 * overlays never touch a battery or solar class. A read that reached the parse
 * conformed to the device-read contract, so a declared `measure_power` carries
 * a finite value and a source stamp.
 */
export function withHomeBatteryParseFields(
    snapshot: TransportDeviceSnapshot,
    device: HomeyDeviceLike,
    deviceClassKey: string,
    overlay: { capabilities: readonly string[]; capabilityObj: DeviceCapabilityMap },
    previousSnapshot: TransportDeviceSnapshot | undefined,
): TransportDeviceSnapshot {
    if (deviceClassKey !== HOME_BATTERY_CLASS_KEY) return snapshot;
    const { capabilities, capabilityObj } = overlay;
    const controlSurface = resolveBatteryControlSurface(device, capabilities, capabilityObj);
    const powerEntry = capabilities.includes(MEASURE_POWER_CAPABILITY_ID)
        ? capabilityObj[MEASURE_POWER_CAPABILITY_ID]
        : undefined;
    const signedW = readSignedPowerW(powerEntry?.value);
    const powerObservedAtMs = toCapabilityTimestampMs(powerEntry?.lastUpdated);
    const batteryPower = signedW !== undefined && powerObservedAtMs !== undefined
        ? { signedW, observedAtMs: powerObservedAtMs }
        : undefined;
    const batteryClaim = resolveParsedClaim(controlSurface, capabilityObj, previousSnapshot);
    const batteryLevel = resolveParsedLevel(capabilities, capabilityObj, previousSnapshot);
    return {
        ...snapshot,
        homeBattery: { controlSurface },
        ...(batteryPower !== undefined
            ? { batteryPower, ...resolveDischargingDrawView(snapshot, batteryPower) }
            : {}),
        ...(batteryClaim !== undefined ? { batteryClaim } : {}),
        ...(batteryLevel !== undefined ? { batteryLevel } : {}),
    };
}

/**
 * A realtime `measure_power` report on a home battery: stores the signed
 * reading, stamped even when the value repeats (a steady reading is still a
 * fresh one), and returns its draw view in kW. `null` for a reading that is
 * not a finite number, which the caller rejects like any other junk reading
 * (`normalizeMeasuredPowerKw`).
 */
/* eslint-disable functional/immutable-data -- Realtime writes update the transport-owned snapshot in place. */
export function applyHomeBatteryPowerObservation(
    snapshot: TransportDeviceSnapshot & HomeBatteryDescriptorFields,
    value: unknown,
    observedAtMs: number,
): number | null {
    const signedW = readSignedPowerW(value);
    if (signedW === undefined) return null;
    const mutableSnapshot = snapshot;
    mutableSnapshot.batteryPower = { signedW, observedAtMs };
    return toHomeBatteryDrawKw(signedW);
}

/**
 * A realtime report on the battery's claim capability. True when the event
 * was a claim event, whether or not it changed anything. Dated on arrival: the
 * live feed hands PELS no source time for it, which is why a pulled read that
 * disagrees wins (`resolveParsedClaim`). Published as an observed-state change
 * only: the claim is planner input (whether PELS's setpoint is engaged), never a
 * reason to re-decide, so it is not a control-state change.
 */
export function handleHomeBatteryClaimCapabilityUpdate(
    nextObservationCursor: (deviceId: string) => ObservationCursor,
    dispatchObservedStateChanged: (event: ObservedDeviceStateEvent) => void,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): boolean {
    if (!isHomeBatterySnapshot(snapshot)) return false;
    const { controlSurface } = snapshot.homeBattery;
    if (controlSurface.kind !== 'setpoint' || controlSurface.claim.capabilityId !== capabilityId) return false;
    const claimValue = readClaimValue(value);
    if (claimValue === undefined) return true;
    const mutableSnapshot = snapshot;
    mutableSnapshot.batteryClaim = { value: claimValue, observedAtMs: Date.now() };
    dispatchObservedStateChanged({
        source: 'realtime_capability',
        deviceId: snapshot.id,
        ...nextObservationCursor(snapshot.id),
        capabilityId,
    });
    return true;
}

/**
 * A realtime `measure_battery` report on a home battery: stores the level the
 * card shows. True when the event was a battery level event, whether or not it
 * held a usable value. Published as an observed-state change only: nothing
 * decides on a battery's level.
 */
export function handleHomeBatteryLevelCapabilityUpdate(
    nextObservationCursor: (deviceId: string) => ObservationCursor,
    dispatchObservedStateChanged: (event: ObservedDeviceStateEvent) => void,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): boolean {
    if (capabilityId !== MEASURE_BATTERY_CAPABILITY_ID || !isHomeBatterySnapshot(snapshot)) return false;
    const percent = normalizeStateOfChargePercent(value);
    if (percent === undefined) return true;
    const mutableSnapshot = snapshot;
    mutableSnapshot.batteryLevel = { percent, observedAtMs: Date.now() };
    dispatchObservedStateChanged({
        source: 'realtime_capability',
        deviceId: snapshot.id,
        ...nextObservationCursor(snapshot.id),
        capabilityId,
    });
    return true;
}

/**
 * Fresher-wins for the signed power and the charge level across a full
 * refresh: a pull whose source stamp predates the realtime reading already
 * held must not roll it back. The draw view of the same power reading is
 * carried by `preserveNewerMeteredPowerReading` on the same stamps. A reading
 * the pull no longer resolves stays absent; the parser decides presence. The
 * claim is settled at parse (`resolveParsedClaim`).
 */
export function preserveNewerHomeBatteryReadings(
    previous: TransportDeviceSnapshot,
    next: TransportDeviceSnapshot,
): void {
    const snapshot = next;
    if (isNewerHeld(previous.batteryPower, next.batteryPower)) snapshot.batteryPower = previous.batteryPower;
    if (isNewerHeld(previous.batteryLevel, next.batteryLevel)) snapshot.batteryLevel = previous.batteryLevel;
}

const isNewerHeld = (
    retained: { observedAtMs: number } | undefined,
    incoming: { observedAtMs: number } | undefined,
): boolean => retained !== undefined && incoming !== undefined && retained.observedAtMs > incoming.observedAtMs;
/* eslint-enable functional/immutable-data */
