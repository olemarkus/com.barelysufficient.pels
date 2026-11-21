import type { RelayMeterObservation } from '../ports/nativeRelay';
import type { NativeRelayMeter, ProjectedObservedDeviceState } from '../../packages/contracts/src/types';

type Received<T> = T & { receivedAtMs: number };

function acceptReading<T extends { atMs: number }>(
    previous: Received<T> | undefined, incoming: T | undefined, receivedAtMs: number,
): Received<T> | undefined {
    if (!incoming || incoming.atMs > receivedAtMs || (previous && incoming.atMs <= previous.atMs)) return previous;
    return { ...incoming, receivedAtMs };
}

/** A callback can arrive just after the device measured its value. A dated copy
 * of that same report can verify it. An older contradictory value cannot. */
function observeWatts(
    previous: RelayMeterObservation | undefined, sample: NativeRelayMeter['watts'], receivedAtMs: number,
): Pick<RelayMeterObservation, 'watts' | 'datedWatts'> {
    const latest = previous?.watts;
    const datedWatts = acceptReading(previous?.datedWatts, sample?.sourceDated ? sample : undefined, receivedAtMs);
    const verifiesCallback = latest?.sourceDated === false && datedWatts !== previous?.datedWatts
        && datedWatts?.value === latest.value;
    return { datedWatts, watts: verifiesCallback ? datedWatts : acceptReading(latest, sample, receivedAtMs) };
}

function acceptedBinary(state: ProjectedObservedDeviceState) {
    const binary = state.binaryControlObservation;
    return state.available !== false && binary?.capabilityId === 'onoff'
        && binary.observedValue === state.binaryControl?.on
        ? binary : undefined;
}

/** Keep each sample's first receipt time across capability echoes and cached refreshes. */
export function observeRelayMeter(
    state: ProjectedObservedDeviceState, receivedAtMs: number | undefined, previous?: RelayMeterObservation,
): RelayMeterObservation | undefined {
    const binary = acceptedBinary(state);
    if (!binary || receivedAtMs === undefined) return undefined;
    const power = observeWatts(previous, state.nativeRelayMeter?.watts, receivedAtMs);
    const energy = acceptReading(previous?.energy, state.nativeRelayMeter?.energy, receivedAtMs);
    // A newer payload can contain an older individual capability.
    if (binary.observedAtMs > receivedAtMs || (previous && binary.observedAtMs < previous.binaryAtMs)) {
        return previous && { ...previous, ...power, energy };
    }
    const becameOn = binary.observedValue && previous?.on === false;
    return { on: binary.observedValue, binaryAtMs: binary.observedAtMs,
        lastOpposingOnAtMs: becameOn ? binary.observedAtMs : previous?.lastOpposingOnAtMs, ...power, energy };
}
