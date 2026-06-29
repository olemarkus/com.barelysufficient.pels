import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceId } from './managerHelpers';
import { EV_SOC_NATIVE_CAPABILITY_IDS } from './stateOfCharge';
import {
    buildCapabilityObservationKey,
    type CapabilityObservation,
    type CapabilityObservationSource,
    type DeviceTransportObservationState,
} from './observationState';
import { applyCapabilityObservation, clearCapabilityObservationIfMatched } from './observationApply';

export function mergeFresherCapabilityObservations(params: {
    state: DeviceTransportObservationState;
    previousSnapshot: TransportDeviceSnapshot[];
    nextSnapshot: TransportDeviceSnapshot[];
    devices: HomeyDeviceLike[];
    logger: { debug: (...args: unknown[]) => void };
    debugStructured?: StructuredDebugEmitter;
}): void {
    const {
        state,
        previousSnapshot,
        nextSnapshot,
        devices,
        logger,
        debugStructured,
    } = params;
    const previousById = new Map(previousSnapshot.map((device) => [device.id, device]));
    const devicesById = new Map<string, HomeyDeviceLike>();
    for (const device of devices) {
        const deviceId = getDeviceId(device);
        if (!deviceId) continue;
        devicesById.set(deviceId, device);
    }

    // `lastFreshDataMs` on each snapshot is already set by `parseDevice` from the
    // highest Homey per-capability `lastUpdated` (see `resolveLastFreshDataMs` in
    // `deviceManagerParseSnapshot.ts`). That is the device's actual liveness
    // signal — Homey only advances `lastUpdated` when a capability genuinely
    // reported. A successful refresh poll is *not* by itself evidence the device
    // is alive: Homey serves cached capability values even when the device has
    // been silent for hours. The 40-minute `STALE_DEVICE_OBSERVATION_MS` window
    // (in `lib/observer/observationFreshness.ts`) is the backstop.
    for (const snapshot of nextSnapshot) {
        const previous = previousById.get(snapshot.id);
        const sourceDevice = devicesById.get(snapshot.id);
        if (!previous || !sourceDevice) continue;
        mergeSnapshotObservationsForDevice({
            state,
            nextSnapshot: snapshot,
            previous,
            sourceDevice,
            logger,
            debugStructured,
        });
    }
}

function mergeSnapshotObservationsForDevice(params: {
    state: DeviceTransportObservationState;
    nextSnapshot: TransportDeviceSnapshot;
    previous: TransportDeviceSnapshot;
    sourceDevice: HomeyDeviceLike;
    logger: { debug: (...args: unknown[]) => void };
    debugStructured?: StructuredDebugEmitter;
}): void {
    const {
        state,
        nextSnapshot,
        previous,
        sourceDevice,
        logger,
        debugStructured,
    } = params;
    const snapshot = nextSnapshot;
    snapshot.lastLocalWriteMs = Math.max(
        snapshot.lastLocalWriteMs ?? 0,
        previous.lastLocalWriteMs ?? 0,
    ) || undefined;
    snapshot.lastFreshDataMs = Math.max(
        snapshot.lastFreshDataMs ?? 0,
        previous.lastFreshDataMs ?? 0,
    ) || undefined;
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    preserveBinaryControlObservation({
        previous,
        snapshot,
    });

    if (snapshot.controlCapabilityId) {
        mergeCapabilityObservation({
            state,
            deviceId: snapshot.id,
            deviceName: snapshot.name,
            capabilityId: snapshot.controlCapabilityId,
            sourceDevice,
            nextSnapshot: snapshot,
            logger,
            debugStructured,
        });
    }

    for (const target of snapshot.targets) {
        mergeCapabilityObservation({
            state,
            deviceId: snapshot.id,
            deviceName: snapshot.name,
            capabilityId: target.id,
            sourceDevice,
            nextSnapshot: snapshot,
            logger,
        });
    }

    for (const capabilityId of [
        'measure_power',
        'measure_temperature',
        'evcharger_charging_state',
    ]) {
        mergeCapabilityObservation({
            state,
            deviceId: snapshot.id,
            deviceName: snapshot.name,
            capabilityId,
            sourceDevice,
            nextSnapshot: snapshot,
            logger,
        });
    }
    mergeStateOfChargeObservationsForDevice({
        state,
        snapshot,
        sourceDevice,
        logger,
    });
    dropRawEvBinaryObservationWhenStatePresent(snapshot, sourceDevice);

    const maxRetainedMs = getMaxRetainedObservationTimeMs(state, snapshot);
    if (maxRetainedMs > 0) {
        snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, maxRetainedMs) || undefined;
        snapshot.lastUpdated = snapshot.lastFreshDataMs;
    }
}

function preserveBinaryControlObservation(params: {
    previous: TransportDeviceSnapshot;
    snapshot: TransportDeviceSnapshot;
}): void {
    const {
        previous,
        snapshot,
    } = params;
    const previousObservation = previous.binaryControlObservation;
    const nextObservation = snapshot.binaryControlObservation;
    if (!previousObservation) return;
    if (previousObservation.capabilityId === 'evcharger_charging' && snapshot.evChargingState !== undefined) {
        if (!previousObservation.observedCapabilityIds.includes('evcharger_charging_state')) {
            if (nextObservation?.observedCapabilityIds.includes('evcharger_charging_state')) return;
            delete snapshot.binaryControlObservation;
            return;
        }
        if (nextObservation && nextObservation.observedAtMs >= previousObservation.observedAtMs) return;
    }
    if (!nextObservation || nextObservation.observedAtMs < previousObservation.observedAtMs) {
        snapshot.binaryControlObservation = {
            ...previousObservation,
            observedCapabilityIds: [...previousObservation.observedCapabilityIds],
        };
    }
}

function dropRawEvBinaryObservationWhenStatePresent(
    snapshot: TransportDeviceSnapshot,
    sourceDevice: HomeyDeviceLike,
): void {
    const mutableSnapshot = snapshot;
    if (
        mutableSnapshot.evChargingState === undefined
        && sourceDevice.capabilitiesObj?.evcharger_charging_state?.value === undefined
    ) {
        return;
    }
    const observation = mutableSnapshot.binaryControlObservation;
    if (!observation || observation.capabilityId !== 'evcharger_charging') return;
    if (observation.observedCapabilityIds.includes('evcharger_charging_state')) return;
    delete mutableSnapshot.binaryControlObservation;
}

function mergeStateOfChargeObservationsForDevice(params: {
    state: DeviceTransportObservationState;
    snapshot: TransportDeviceSnapshot;
    sourceDevice: HomeyDeviceLike;
    logger: { debug: (...args: unknown[]) => void };
}): void {
    const {
        state,
        snapshot,
        sourceDevice,
        logger,
    } = params;
    let newestCapabilityId: string | undefined;
    let newestObservedAt = 0;
    for (const capabilityId of EV_SOC_NATIVE_CAPABILITY_IDS) {
        const observation = state.capabilityObservations.get(
            buildCapabilityObservationKey(snapshot.id, capabilityId),
        );
        if (!observation || observation.observedAt <= newestObservedAt) continue;
        newestCapabilityId = capabilityId;
        newestObservedAt = observation.observedAt;
    }
    if (!newestCapabilityId) return;

    for (const capabilityId of EV_SOC_NATIVE_CAPABILITY_IDS) {
        if (capabilityId === newestCapabilityId) continue;
        const observation = state.capabilityObservations.get(
            buildCapabilityObservationKey(snapshot.id, capabilityId),
        );
        if (!observation || observation.observedAt > newestObservedAt) continue;
        state.capabilityObservations.delete(buildCapabilityObservationKey(snapshot.id, capabilityId));
    }

    mergeCapabilityObservation({
        state,
        deviceId: snapshot.id,
        deviceName: snapshot.name,
        capabilityId: newestCapabilityId,
        sourceDevice,
        nextSnapshot: snapshot,
        logger,
    });
}

function getMaxRetainedObservationTimeMs(
    state: DeviceTransportObservationState,
    snapshot: TransportDeviceSnapshot,
): number {
    const capabilityIds = [
        'measure_power',
        'measure_temperature',
        'evcharger_charging_state',
        ...(snapshot.controlCapabilityId ? [snapshot.controlCapabilityId] : []),
        ...snapshot.targets.map((target) => target.id),
    ];
    let max = 0;
    for (const capabilityId of capabilityIds) {
        const observation = state.capabilityObservations.get(
            buildCapabilityObservationKey(snapshot.id, capabilityId),
        );
        if (observation && observation.source !== 'local_write') {
            max = Math.max(max, observation.observedAt);
        }
    }
    return max;
}

function mergeCapabilityObservation(params: {
    state: DeviceTransportObservationState;
    deviceId: string;
    deviceName: string;
    capabilityId: string;
    sourceDevice: HomeyDeviceLike;
    nextSnapshot: TransportDeviceSnapshot;
    logger: { debug: (...args: unknown[]) => void };
    debugStructured?: StructuredDebugEmitter;
}): void {
    const {
        state,
        deviceId,
        deviceName,
        capabilityId,
        sourceDevice,
        nextSnapshot,
        logger,
        debugStructured,
    } = params;
    const observation = state.capabilityObservations.get(buildCapabilityObservationKey(deviceId, capabilityId));
    if (!observation) return;
    if (
        capabilityId === 'evcharger_charging_state'
        && observation.source === 'device_update'
        && !deviceSupportsCapability(sourceDevice, capabilityId)
    ) {
        return;
    }
    const fetchedLastUpdatedMs = getCapabilityLastUpdatedMs(sourceDevice, capabilityId);
    const fetchedHasKnownFreshness = typeof fetchedLastUpdatedMs === 'number'
        && Number.isFinite(fetchedLastUpdatedMs);
    const fetchedIsFreshEnough = fetchedHasKnownFreshness && fetchedLastUpdatedMs >= observation.observedAt;
    // For the binary control capability, log both sources' observations and the
    // value the observer consolidates them to (the two-source reconciliation we
    // want visibility on). `emitBinaryConsolidation` no-ops for non-control capabilities.
    const fetchedValue = sourceDevice.capabilitiesObj?.[capabilityId]?.value;
    const consolidationCtx: ConsolidationContext = {
        debugStructured,
        nextSnapshot,
        deviceId,
        deviceName,
        capabilityId,
        fetchedValue,
        fetchedLastUpdatedMs,
        observation,
    };
    if (fetchedIsFreshEnough) {
        emitBinaryConsolidation(consolidationCtx, fetchedValue, 'pull', 'pull_fresher_or_equal');
        clearCapabilityObservationIfMatched(state, deviceId, capabilityId, nextSnapshot);
        return;
    }
    const shouldPreserveObservation = shouldPreserveRetainedObservation({
        source: observation.source,
        fetchedHasKnownFreshness,
        fetchedLastUpdatedMs,
        observedAt: observation.observedAt,
    });
    if (!shouldPreserveObservation) {
        emitBinaryConsolidation(consolidationCtx, fetchedValue, 'pull', 'retained_not_preserved');
        return;
    }
    if (!applyCapabilityObservation(nextSnapshot, capabilityId, observation)) {
        emitBinaryConsolidation(consolidationCtx, observation.value, 'agree', 'values_match');
        return;
    }
    emitBinaryConsolidation(consolidationCtx, observation.value, 'retained', 'retained_fresher');
    logger.debug({
        event: 'snapshot_refresh_preserved_newer',
        deviceId,
        deviceName,
        source: observation.source,
        capabilityId,
        observedAtMs: observation.observedAt,
        fetchedLastUpdatedMs: typeof fetchedLastUpdatedMs === 'number' && Number.isFinite(fetchedLastUpdatedMs)
            ? fetchedLastUpdatedMs
            : null,
    });
}

function shouldPreserveRetainedObservation(params: {
    source: CapabilityObservationSource;
    fetchedHasKnownFreshness: boolean;
    fetchedLastUpdatedMs?: number;
    observedAt: number;
}): boolean {
    const { source, fetchedHasKnownFreshness, fetchedLastUpdatedMs, observedAt } = params;
    const fetchedIsOlder = fetchedLastUpdatedMs !== undefined && fetchedLastUpdatedMs < observedAt;
    if (source === 'device_update') {
        return !fetchedHasKnownFreshness || fetchedIsOlder;
    }
    return fetchedHasKnownFreshness && fetchedIsOlder;
}

type ConsolidationWinner = 'pull' | 'retained' | 'agree';

type ConsolidationContext = {
    debugStructured?: StructuredDebugEmitter;
    nextSnapshot: TransportDeviceSnapshot;
    deviceId: string;
    deviceName: string;
    capabilityId: string;
    fetchedValue: unknown;
    fetchedLastUpdatedMs?: number;
    observation: CapabilityObservation;
};

function emitBinaryConsolidation(
    ctx: ConsolidationContext,
    consolidatedValue: unknown,
    winner: ConsolidationWinner,
    reason: string,
): void {
    if (ctx.capabilityId !== ctx.nextSnapshot.controlCapabilityId) return;
    ctx.debugStructured?.({
        event: 'binary_observation_consolidated',
        deviceId: ctx.deviceId,
        deviceName: ctx.deviceName,
        capabilityId: ctx.capabilityId,
        pull: {
            value: ctx.fetchedValue ?? null,
            observedAtMs: ctx.fetchedLastUpdatedMs ?? null,
        },
        retained: {
            value: ctx.observation.value ?? null,
            observedAtMs: ctx.observation.observedAt,
            source: ctx.observation.source,
        },
        consolidated: { value: consolidatedValue ?? null, winner, reason },
    });
}

function deviceSupportsCapability(device: HomeyDeviceLike, capabilityId: string): boolean {
    return device.capabilities?.includes(capabilityId) === true
        || Boolean(device.capabilitiesObj?.[capabilityId]);
}

function getCapabilityLastUpdatedMs(
    device: HomeyDeviceLike,
    capabilityId: string,
): number | undefined {
    const rawValue = device.capabilitiesObj?.[capabilityId]?.lastUpdated;
    if (rawValue instanceof Date) return rawValue.getTime();
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
        const parsed = Date.parse(rawValue);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}
