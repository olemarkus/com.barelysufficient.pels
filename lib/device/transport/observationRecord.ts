import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import {
    EV_SOC_NATIVE_CAPABILITY_IDS,
    isStateOfChargeCapabilityId,
} from './stateOfCharge';
import {
    buildCapabilityObservationKey,
    type CapabilityObservationSource,
    type DeviceTransportObservationState,
} from './observationState';
import { buildCurrentDebugSnapshot, getOrCreateDebugObservedSources } from './observationDebugSources';

type RecordSnapshotObservationOptions = {
    state: DeviceTransportObservationState;
    deviceId: string;
    snapshot: TransportDeviceSnapshot;
    source: CapabilityObservationSource;
    observedAt: number;
    capabilityIdSet: ReadonlySet<string>;
};

export function recordLocalWriteObservation(params: {
    state: DeviceTransportObservationState;
    latestSnapshot: TransportDeviceSnapshot[];
    deviceId: string;
    capabilityId: string;
    value: unknown;
    preservedLocalState: boolean;
}): void {
    const {
        state,
        latestSnapshot,
        deviceId,
        capabilityId,
        value,
        preservedLocalState,
    } = params;
    const observedAt = Date.now();
    const sources = getOrCreateDebugObservedSources(state, deviceId);
    sources.localWrites[capabilityId] = {
        observedAt,
        path: 'local_write',
        snapshot: buildCurrentDebugSnapshot(latestSnapshot, deviceId),
        capabilityId,
        value,
        preservedLocalState,
    };
    recordCapabilityObservation({
        state,
        latestSnapshot,
        deviceId,
        capabilityId,
        value,
        source: 'local_write',
        observedAt,
        countsTowardDeviceFreshness: false,
    });
}

export function recordSnapshotCapabilityObservations(params: {
    state: DeviceTransportObservationState;
    latestSnapshot: TransportDeviceSnapshot[];
    deviceId: string;
    source: CapabilityObservationSource;
    capabilityIds: readonly string[];
}): void {
    const {
        state,
        latestSnapshot,
        deviceId,
        source,
        capabilityIds,
    } = params;
    const snapshot = latestSnapshot.find((entry) => entry.id === deviceId);
    if (!snapshot) return;
    const observedAt = Date.now();
    const capabilityIdSet: ReadonlySet<string> = new Set(capabilityIds);
    const recordedFreshData = [
        recordSnapshotControlObservation({ state, deviceId, snapshot, source, observedAt, capabilityIdSet }),
        recordSnapshotTargetObservations({ state, deviceId, snapshot, source, observedAt, capabilityIdSet }),
        recordSnapshotScalarObservation(state, snapshot, {
            deviceId,
            capabilityId: 'measure_temperature',
            value: snapshot.temperature?.currentTemperature,
            source,
            observedAt,
            capabilityIdSet,
            countsTowardDeviceFreshness: true,
        }),
        recordSnapshotScalarObservation(state, snapshot, {
            deviceId,
            capabilityId: 'measure_power',
            value: snapshot.measuredPowerKw,
            source,
            observedAt,
            capabilityIdSet,
            countsTowardDeviceFreshness: true,
        }),
        recordSnapshotScalarObservation(state, snapshot, {
            deviceId,
            capabilityId: 'evcharger_charging_state',
            value: snapshot.evChargingState,
            source,
            observedAt,
            capabilityIdSet,
            countsTowardDeviceFreshness: true,
        }),
    ].some(Boolean);
    forgetSupersededMeasuredPower(state, snapshot, capabilityIdSet);
    const stateOfChargeCapabilityId = snapshot.stateOfCharge?.capabilityId;
    const observedStateOfChargeCapabilityId = stateOfChargeCapabilityId
        && isStateOfChargeCapabilityId(stateOfChargeCapabilityId)
        ? stateOfChargeCapabilityId
        : 'measure_battery';
    recordSnapshotScalarObservation(state, snapshot, {
        deviceId,
        capabilityId: observedStateOfChargeCapabilityId,
        value: snapshot.stateOfCharge?.report.percent,
        source,
        observedAt,
        capabilityIdSet,
        countsTowardDeviceFreshness: false,
    });
    if (recordedFreshData) {
        snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observedAt);
        snapshot.lastUpdated = snapshot.lastFreshDataMs;
    }
}

export function recordCapabilityObservation(params: {
    state: DeviceTransportObservationState;
    latestSnapshot: TransportDeviceSnapshot[];
    deviceId: string;
    capabilityId: string;
    value: unknown;
    source: CapabilityObservationSource;
    observedAt?: number;
    snapshot?: TransportDeviceSnapshot;
    countsTowardDeviceFreshness: boolean;
}): void {
    const {
        state,
        latestSnapshot,
        deviceId,
        capabilityId,
        value,
        source,
        observedAt = Date.now(),
        snapshot,
        countsTowardDeviceFreshness,
    } = params;
    state.capabilityObservations.set(buildCapabilityObservationKey(deviceId, capabilityId), {
        value,
        observedAt,
        source,
        countsTowardDeviceFreshness,
    });
    const resolvedSnapshot = snapshot ?? latestSnapshot.find((entry) => entry.id === deviceId);
    if (!resolvedSnapshot) return;
    if (source === 'local_write') {
        updateLocalWriteTimestamps(state, latestSnapshot, deviceId, observedAt, resolvedSnapshot);
        return;
    }
    if (!countsTowardDeviceFreshness) return;
    resolvedSnapshot.lastFreshDataMs = Math.max(resolvedSnapshot.lastFreshDataMs ?? 0, observedAt);
    resolvedSnapshot.lastUpdated = resolvedSnapshot.lastFreshDataMs;
}

export function resolveLatestLocalWriteMs(
    state: DeviceTransportObservationState,
    deviceId: string,
): number | undefined {
    return state.latestLocalWriteMsByDeviceId.get(deviceId);
}

function recordSnapshotControlObservation(options: RecordSnapshotObservationOptions): boolean {
    const {
        state,
        deviceId,
        snapshot,
        source,
        observedAt,
        capabilityIdSet,
    } = options;
    if (
        !snapshot.binaryCapabilityId
        || !capabilityIdSet.has(snapshot.binaryCapabilityId)
    ) {
        return false;
    }
    const controlValue = snapshot.binaryCapabilityId === 'evcharger_charging'
        ? snapshot.evCharging
        : snapshot.binaryControl?.on;
    if (typeof controlValue !== 'boolean') {
        return false;
    }
    recordCapabilityObservation({
        state,
        latestSnapshot: [],
        deviceId,
        capabilityId: snapshot.binaryCapabilityId,
        value: controlValue,
        source,
        observedAt,
        snapshot,
        countsTowardDeviceFreshness: true,
    });
    return true;
}

function recordSnapshotTargetObservations(options: RecordSnapshotObservationOptions): boolean {
    const {
        state,
        deviceId,
        snapshot,
        source,
        observedAt,
        capabilityIdSet,
    } = options;
    let recorded = false;
    for (const target of snapshot.targets) {
        if (!capabilityIdSet.has(target.id)) continue;
        recordCapabilityObservation({
            state,
            latestSnapshot: [],
            deviceId,
            capabilityId: target.id,
            value: target.value,
            source,
            observedAt,
            snapshot,
            countsTowardDeviceFreshness: true,
        });
        recorded = true;
    }
    return recorded;
}

function recordSnapshotScalarObservation(
    state: DeviceTransportObservationState,
    snapshot: TransportDeviceSnapshot,
    params: {
        deviceId: string;
        capabilityId: 'measure_temperature' | 'measure_power' | 'evcharger_charging_state'
            | (typeof EV_SOC_NATIVE_CAPABILITY_IDS)[number];
        value: number | string | undefined;
        source: CapabilityObservationSource;
        observedAt: number;
        capabilityIdSet: ReadonlySet<string>;
        countsTowardDeviceFreshness: boolean;
    },
): boolean {
    const {
        deviceId,
        capabilityId,
        value,
        source,
        observedAt,
        capabilityIdSet,
        countsTowardDeviceFreshness,
    } = params;
    if (typeof value !== 'number' && typeof value !== 'string') return false;
    if (!capabilityIdSet.has(capabilityId)) return false;
    recordCapabilityObservation({
        state,
        latestSnapshot: [],
        deviceId,
        capabilityId,
        value,
        source,
        observedAt,
        snapshot,
        countsTowardDeviceFreshness,
    });
    return true;
}

/**
 * An observation that saw the measured power change TO no reading is the newest
 * word on it, so the value an earlier push retained is superseded and must go.
 *
 * A retained `measure_power` observation exists to outlive an older pull: the
 * refresh merge re-applies it whenever the fetched device cannot prove itself
 * fresher. A device measured only by `meter_power` never can — it has no
 * `measure_power.lastUpdated` — so a rate one `device.update` retained came back
 * on every refresh. Once its meter stopped moving, the next `device.update`
 * resolved no reading (the resolver's no-window case), recorded nothing, and
 * left that rate standing: an idle device read its last running power until its
 * meter moved again. Deleting the retained observation is what closes it; the
 * absence then resolves to no draw at `getCurrentDrawKw`, as a meter that has
 * not moved should.
 *
 * It closes only the case an observation sees. An idle device that sends no
 * further `device.update` still has its last rate re-applied on every refresh,
 * because nothing here observes the drop.
 */
function forgetSupersededMeasuredPower(
    state: DeviceTransportObservationState,
    snapshot: TransportDeviceSnapshot,
    capabilityIdSet: ReadonlySet<string>,
): void {
    if (!capabilityIdSet.has('measure_power')) return;
    if (typeof snapshot.measuredPowerKw === 'number') return;
    state.capabilityObservations.delete(buildCapabilityObservationKey(snapshot.id, 'measure_power'));
}

function updateLocalWriteTimestamps(
    state: DeviceTransportObservationState,
    latestSnapshot: TransportDeviceSnapshot[],
    deviceId: string,
    observedAt: number,
    snapshot?: TransportDeviceSnapshot,
): void {
    const resolvedSnapshot = snapshot ?? latestSnapshot.find((entry) => entry.id === deviceId);
    if (resolvedSnapshot) {
        resolvedSnapshot.lastLocalWriteMs = (
            Math.max(resolvedSnapshot.lastLocalWriteMs ?? 0, observedAt) || undefined
        );
    }
    state.latestLocalWriteMsByDeviceId.set(
        deviceId,
        Math.max(state.latestLocalWriteMsByDeviceId.get(deviceId) ?? 0, observedAt),
    );
}
