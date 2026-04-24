/* eslint-disable max-lines --
 * Observation tracking keeps freshness, retained observations, and debug source state together.
 */
/* eslint-disable max-params --
 * Internal helpers mirror observation fields directly to keep this move-only split simple.
 */
import type { HomeyDeviceLike, TargetDeviceSnapshot } from '../utils/types';
import type { HandleRealtimeDeviceUpdateResult } from './deviceManagerRealtimeHandlers';
import type { DeviceFetchSource } from './deviceManagerFetch';
import { getDeviceId } from './deviceManagerHelpers';
import { resolveEvCurrentOn } from './deviceManagerControl';

export type CapabilityObservationSource = 'device_update' | 'realtime_capability' | 'local_write';

type CapabilityObservation = {
    value: unknown;
    observedAt: number;
    source: CapabilityObservationSource;
};

export type DeviceDebugObservedSource = {
    observedAt: number;
    path: 'snapshot_refresh' | 'device_update' | 'realtime_capability' | 'local_write';
    snapshot: TargetDeviceSnapshot | null;
    fetchSource?: DeviceFetchSource;
    capabilityId?: string;
    value?: unknown;
    localEcho?: boolean;
    shouldReconcilePlan?: boolean;
    preservedLocalState?: boolean;
    changes?: Array<{
        capabilityId: string;
        previousValue: string;
        nextValue: string;
    }>;
};

export type DeviceDebugObservedSources = {
    snapshotRefresh?: DeviceDebugObservedSource;
    deviceUpdate?: DeviceDebugObservedSource;
    realtimeCapabilities: Record<string, DeviceDebugObservedSource>;
    localWrites: Record<string, DeviceDebugObservedSource>;
};

export type DeviceManagerObservationState = {
    debugObservedSourcesByDeviceId: Map<string, DeviceDebugObservedSources>;
    capabilityObservations: Map<string, CapabilityObservation>;
    latestLocalWriteMsByDeviceId: Map<string, number>;
};

export function createObservationState(): DeviceManagerObservationState {
    return {
        debugObservedSourcesByDeviceId: new Map(),
        capabilityObservations: new Map(),
        latestLocalWriteMsByDeviceId: new Map(),
    };
}

export function getDebugObservedSources(
    state: DeviceManagerObservationState,
    deviceId: string,
): DeviceDebugObservedSources | null {
    const sources = state.debugObservedSourcesByDeviceId.get(deviceId);
    if (!sources) return null;
    return {
        ...(sources.snapshotRefresh ? { snapshotRefresh: cloneObservedSource(sources.snapshotRefresh) } : {}),
        ...(sources.deviceUpdate ? { deviceUpdate: cloneObservedSource(sources.deviceUpdate) } : {}),
        realtimeCapabilities: Object.fromEntries(
            Object.entries(sources.realtimeCapabilities).map(([capabilityId, source]) => [
                capabilityId,
                cloneObservedSource(source),
            ]),
        ),
        localWrites: Object.fromEntries(
            Object.entries(sources.localWrites).map(([capabilityId, source]) => [
                capabilityId,
                cloneObservedSource(source),
            ]),
        ),
    };
}

export function recordSnapshotRefreshObservations(params: {
    state: DeviceManagerObservationState;
    snapshot: TargetDeviceSnapshot[];
    fetchSource: DeviceFetchSource;
}): void {
    const {
        state,
        snapshot,
        fetchSource,
    } = params;
    const observedAt = Date.now();
    const activeDeviceIds = new Set(snapshot.map((device) => device.id));
    for (const deviceId of state.debugObservedSourcesByDeviceId.keys()) {
        if (!activeDeviceIds.has(deviceId)) {
            state.debugObservedSourcesByDeviceId.delete(deviceId);
        }
    }
    for (const device of snapshot) {
        const sources = getOrCreateDebugObservedSources(state, device.id);
        sources.snapshotRefresh = {
            observedAt,
            path: 'snapshot_refresh',
            snapshot: cloneTargetDeviceSnapshotForDebug(device),
            fetchSource,
        };
    }
}

export function recordDeviceUpdateObservation(params: {
    state: DeviceManagerObservationState;
    latestSnapshot: TargetDeviceSnapshot[];
    deviceId: string;
    result: HandleRealtimeDeviceUpdateResult;
}): void {
    const {
        state,
        latestSnapshot,
        deviceId,
        result,
    } = params;
    const sources = getOrCreateDebugObservedSources(state, deviceId);
    sources.deviceUpdate = {
        observedAt: Date.now(),
        path: 'device_update',
        snapshot: buildCurrentDebugSnapshot(latestSnapshot, deviceId),
        shouldReconcilePlan: result.shouldReconcilePlan,
        ...(result.changes.length > 0 ? { changes: result.changes.map((change) => ({ ...change })) } : {}),
    };
}

export function recordLocalWriteObservation(params: {
    state: DeviceManagerObservationState;
    latestSnapshot: TargetDeviceSnapshot[];
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
    });
}

export function mergeFresherCapabilityObservations(params: {
    state: DeviceManagerObservationState;
    previousSnapshot: TargetDeviceSnapshot[];
    nextSnapshot: TargetDeviceSnapshot[];
    devices: HomeyDeviceLike[];
    targetedRefreshPollAtMs?: number;
    logger: { debug: (...args: unknown[]) => void };
}): void {
    const {
        state,
        previousSnapshot,
        nextSnapshot,
        devices,
        targetedRefreshPollAtMs,
        logger,
    } = params;
    const previousById = new Map(previousSnapshot.map((device) => [device.id, device]));
    const devicesById = new Map<string, HomeyDeviceLike>();
    for (const device of devices) {
        const deviceId = getDeviceId(device);
        if (!deviceId) continue;
        devicesById.set(deviceId, device);
    }

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
        });
        if (targetedRefreshPollAtMs) {
            snapshot.lastFreshDataMs = Math.max(
                snapshot.lastFreshDataMs ?? 0,
                targetedRefreshPollAtMs,
            ) || undefined;
            snapshot.lastUpdated = snapshot.lastFreshDataMs;
        }
    }
}

export function recordSnapshotCapabilityObservations(params: {
    state: DeviceManagerObservationState;
    latestSnapshot: TargetDeviceSnapshot[];
    deviceId: string;
    source: CapabilityObservationSource;
    capabilityIds?: string[];
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
    const capabilityIdSet = capabilityIds ? new Set(capabilityIds) : null;
    const recordedFreshData = [
        recordSnapshotControlObservation(state, deviceId, snapshot, source, observedAt, capabilityIdSet),
        recordSnapshotTargetObservations(state, deviceId, snapshot, source, observedAt, capabilityIdSet),
        recordSnapshotScalarObservation(state, snapshot, {
            deviceId,
            capabilityId: 'measure_power',
            value: snapshot.measuredPowerKw,
            source,
            observedAt,
            capabilityIdSet,
        }),
        recordSnapshotScalarObservation(state, snapshot, {
            deviceId,
            capabilityId: 'evcharger_charging_state',
            value: snapshot.evChargingState,
            source,
            observedAt,
            capabilityIdSet,
        }),
    ].some(Boolean);
    if (recordedFreshData) {
        snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observedAt);
        snapshot.lastUpdated = snapshot.lastFreshDataMs;
    }
}

export function recordCapabilityObservation(params: {
    state: DeviceManagerObservationState;
    latestSnapshot: TargetDeviceSnapshot[];
    deviceId: string;
    capabilityId: string;
    value: unknown;
    source: CapabilityObservationSource;
    observedAt?: number;
    snapshot?: TargetDeviceSnapshot;
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
    } = params;
    state.capabilityObservations.set(buildCapabilityObservationKey(deviceId, capabilityId), {
        value,
        observedAt,
        source,
    });
    const resolvedSnapshot = snapshot ?? latestSnapshot.find((entry) => entry.id === deviceId);
    if (!resolvedSnapshot) return;
    if (source === 'local_write') {
        updateLocalWriteTimestamps(state, latestSnapshot, deviceId, observedAt, resolvedSnapshot);
        return;
    }
    resolvedSnapshot.lastFreshDataMs = Math.max(resolvedSnapshot.lastFreshDataMs ?? 0, observedAt);
    resolvedSnapshot.lastUpdated = resolvedSnapshot.lastFreshDataMs;
}

export function resolveLatestLocalWriteMs(
    state: DeviceManagerObservationState,
    deviceId: string,
): number | undefined {
    return state.latestLocalWriteMsByDeviceId.get(deviceId);
}

function cloneTargetDeviceSnapshotForDebug(snapshot: TargetDeviceSnapshot | null): TargetDeviceSnapshot | null {
    if (!snapshot) return null;
    return {
        ...snapshot,
        targets: snapshot.targets.map((target) => ({ ...target })),
        capabilities: Array.isArray(snapshot.capabilities) ? [...snapshot.capabilities] : snapshot.capabilities,
    };
}

function cloneObservedSource(source: DeviceDebugObservedSource): DeviceDebugObservedSource {
    return {
        ...source,
        snapshot: cloneTargetDeviceSnapshotForDebug(source.snapshot),
        changes: source.changes?.map((change) => ({ ...change })),
    };
}

function createEmptyObservedSources(): DeviceDebugObservedSources {
    return {
        realtimeCapabilities: {},
        localWrites: {},
    };
}

function getOrCreateDebugObservedSources(
    state: DeviceManagerObservationState,
    deviceId: string,
): DeviceDebugObservedSources {
    let sources = state.debugObservedSourcesByDeviceId.get(deviceId);
    if (!sources) {
        sources = createEmptyObservedSources();
        state.debugObservedSourcesByDeviceId.set(deviceId, sources);
    }
    return sources;
}

function buildCurrentDebugSnapshot(
    latestSnapshot: TargetDeviceSnapshot[],
    deviceId: string,
): TargetDeviceSnapshot | null {
    const snapshot = latestSnapshot.find((entry) => entry.id === deviceId) ?? null;
    return cloneTargetDeviceSnapshotForDebug(snapshot);
}

function mergeSnapshotObservationsForDevice(params: {
    state: DeviceManagerObservationState;
    nextSnapshot: TargetDeviceSnapshot;
    previous: TargetDeviceSnapshot;
    sourceDevice: HomeyDeviceLike;
    logger: { debug: (...args: unknown[]) => void };
}): void {
    const {
        state,
        nextSnapshot,
        previous,
        sourceDevice,
        logger,
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

    if (snapshot.controlCapabilityId) {
        mergeCapabilityObservation({
            state,
            deviceId: snapshot.id,
            deviceName: snapshot.name,
            capabilityId: snapshot.controlCapabilityId,
            sourceDevice,
            nextSnapshot: snapshot,
            logger,
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

    for (const capabilityId of ['measure_power', 'measure_temperature', 'evcharger_charging_state']) {
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

    const maxRetainedMs = getMaxRetainedObservationTimeMs(state, snapshot);
    if (maxRetainedMs > 0) {
        snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, maxRetainedMs) || undefined;
        snapshot.lastUpdated = snapshot.lastFreshDataMs;
    }
}

function getMaxRetainedObservationTimeMs(
    state: DeviceManagerObservationState,
    snapshot: TargetDeviceSnapshot,
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
    state: DeviceManagerObservationState;
    deviceId: string;
    deviceName: string;
    capabilityId: string;
    sourceDevice: HomeyDeviceLike;
    nextSnapshot: TargetDeviceSnapshot;
    logger: { debug: (...args: unknown[]) => void };
}): void {
    const {
        state,
        deviceId,
        deviceName,
        capabilityId,
        sourceDevice,
        nextSnapshot,
        logger,
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
    if (fetchedIsFreshEnough) {
        clearCapabilityObservationIfMatched(state, deviceId, capabilityId, nextSnapshot);
        return;
    }
    const shouldPreserveObservation = observation.source === 'device_update'
        ? !fetchedHasKnownFreshness || fetchedLastUpdatedMs < observation.observedAt
        : fetchedHasKnownFreshness && fetchedLastUpdatedMs < observation.observedAt;
    if (!shouldPreserveObservation) return;
    if (!applyCapabilityObservation(nextSnapshot, capabilityId, observation)) return;
    logger.debug(
        `Device snapshot refresh preserved newer ${observation.source} ${capabilityId} `
        + `for ${deviceName} (${deviceId}); `
        + `observedAt=${new Date(observation.observedAt).toISOString()}`
        + (typeof fetchedLastUpdatedMs === 'number' && Number.isFinite(fetchedLastUpdatedMs)
            ? `, fetched lastUpdated=${new Date(fetchedLastUpdatedMs).toISOString()}`
            : ', fetched lastUpdated=unknown'),
    );
}

function deviceSupportsCapability(device: HomeyDeviceLike, capabilityId: string): boolean {
    return device.capabilities?.includes(capabilityId) === true
        || Boolean(device.capabilitiesObj?.[capabilityId]);
}

function applyCapabilityObservation(
    nextSnapshot: TargetDeviceSnapshot,
    capabilityId: string,
    observation: CapabilityObservation,
): boolean {
    if (capabilityId === nextSnapshot.controlCapabilityId) {
        return applyControlCapabilityObservation(nextSnapshot, observation);
    }
    if (capabilityId === 'evcharger_charging_state') {
        return applyEvChargingStateObservation(nextSnapshot, observation);
    }
    if (capabilityId === 'measure_power') {
        return applyMeasuredPowerObservation(nextSnapshot, observation);
    }
    if (capabilityId === 'measure_temperature') {
        return applyMeasuredTemperatureObservation(nextSnapshot, observation);
    }
    return applyTargetCapabilityObservation(nextSnapshot, capabilityId, observation);
}

function applyControlCapabilityObservation(
    nextSnapshot: TargetDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (typeof observation.value !== 'boolean') return false;
    const previousCurrentOn = snapshot.currentOn;
    const previousEvCharging = snapshot.evCharging;
    if (snapshot.controlCapabilityId === 'evcharger_charging') {
        snapshot.evCharging = observation.value;
        snapshot.currentOn = resolveEvCurrentOn({
            evChargingState: snapshot.evChargingState,
            evchargerCharging: snapshot.evCharging,
        });
    } else {
        snapshot.currentOn = observation.value;
    }
    if (
        previousCurrentOn === snapshot.currentOn
        && snapshot.controlCapabilityId !== 'evcharger_charging'
    ) {
        return false;
    }
    if (
        previousCurrentOn === snapshot.currentOn
        && snapshot.controlCapabilityId === 'evcharger_charging'
        && previousEvCharging === snapshot.evCharging
    ) {
        return false;
    }
    if (observation.source === 'local_write') {
        snapshot.lastLocalWriteMs = Math.max(snapshot.lastLocalWriteMs ?? 0, observation.observedAt);
        return true;
    }
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs ?? snapshot.lastUpdated;
    return true;
}

function applyEvChargingStateObservation(
    nextSnapshot: TargetDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (typeof observation.value !== 'string' || snapshot.evChargingState === observation.value) return false;
    snapshot.evChargingState = observation.value;
    snapshot.currentOn = resolveEvCurrentOn({
        evChargingState: snapshot.evChargingState,
        evchargerCharging: snapshot.evCharging,
    });
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyMeasuredPowerObservation(
    nextSnapshot: TargetDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (
        typeof observation.value !== 'number'
        || !Number.isFinite(observation.value)
        || Object.is(snapshot.measuredPowerKw, observation.value)
    ) {
        return false;
    }
    snapshot.measuredPowerKw = observation.value;
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyMeasuredTemperatureObservation(
    nextSnapshot: TargetDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (
        typeof observation.value !== 'number'
        || !Number.isFinite(observation.value)
        || Object.is(snapshot.currentTemperature, observation.value)
    ) {
        return false;
    }
    snapshot.currentTemperature = observation.value;
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyTargetCapabilityObservation(
    nextSnapshot: TargetDeviceSnapshot,
    capabilityId: string,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    const target = snapshot.targets.find((entry) => entry.id === capabilityId);
    if (!target) {
        return false;
    }
    let nextValue: number | undefined | null;
    if (typeof observation.value === 'number' && Number.isFinite(observation.value)) {
        nextValue = observation.value;
    } else if (observation.value === undefined) {
        nextValue = undefined;
    } else {
        nextValue = null;
    }
    if (nextValue === null || Object.is(target.value, nextValue)) {
        return false;
    }
    if (nextValue === undefined) delete target.value;
    else target.value = nextValue;
    if (observation.source === 'local_write') {
        snapshot.lastLocalWriteMs = Math.max(snapshot.lastLocalWriteMs ?? 0, observation.observedAt);
        return true;
    }
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function clearCapabilityObservationIfMatched(
    state: DeviceManagerObservationState,
    deviceId: string,
    capabilityId: string,
    snapshot: TargetDeviceSnapshot,
): void {
    const key = buildCapabilityObservationKey(deviceId, capabilityId);
    const observation = state.capabilityObservations.get(key);
    if (!observation) return;
    if (capabilityId === snapshot.controlCapabilityId) {
        if (matchesCurrentControlObservation(snapshot, observation.value)) {
            state.capabilityObservations.delete(key);
        }
        return;
    }
    if (capabilityId === 'measure_power') {
        if (snapshot.measuredPowerKw === observation.value) {
            state.capabilityObservations.delete(key);
        }
        return;
    }
    if (capabilityId === 'measure_temperature') {
        if (snapshot.currentTemperature === observation.value) {
            state.capabilityObservations.delete(key);
        }
        return;
    }
    if (capabilityId === 'evcharger_charging_state') {
        if (snapshot.evChargingState === observation.value) {
            state.capabilityObservations.delete(key);
        }
        return;
    }
    const target = snapshot.targets.find((entry) => entry.id === capabilityId);
    if (target && Object.is(target.value, observation.value)) {
        state.capabilityObservations.delete(key);
    }
}

function matchesCurrentControlObservation(
    snapshot: TargetDeviceSnapshot,
    observationValue: unknown,
): boolean {
    const currentControlValue = snapshot.controlCapabilityId === 'evcharger_charging'
        ? snapshot.evCharging
        : snapshot.currentOn;
    return currentControlValue === observationValue;
}

function recordSnapshotControlObservation(
    state: DeviceManagerObservationState,
    deviceId: string,
    snapshot: TargetDeviceSnapshot,
    source: CapabilityObservationSource,
    observedAt: number,
    capabilityIdSet: Set<string> | null,
): boolean {
    if (
        !snapshot.controlCapabilityId
        || (capabilityIdSet && !capabilityIdSet.has(snapshot.controlCapabilityId))
    ) {
        return false;
    }
    const controlValue = snapshot.controlCapabilityId === 'evcharger_charging'
        ? snapshot.evCharging
        : snapshot.currentOn;
    if (typeof controlValue !== 'boolean') {
        return false;
    }
    recordCapabilityObservation({
        state,
        latestSnapshot: [],
        deviceId,
        capabilityId: snapshot.controlCapabilityId,
        value: controlValue,
        source,
        observedAt,
        snapshot,
    });
    return true;
}

function recordSnapshotTargetObservations(
    state: DeviceManagerObservationState,
    deviceId: string,
    snapshot: TargetDeviceSnapshot,
    source: CapabilityObservationSource,
    observedAt: number,
    capabilityIdSet: Set<string> | null,
): boolean {
    let recorded = false;
    for (const target of snapshot.targets) {
        if (capabilityIdSet && !capabilityIdSet.has(target.id)) continue;
        recordCapabilityObservation({
            state,
            latestSnapshot: [],
            deviceId,
            capabilityId: target.id,
            value: target.value,
            source,
            observedAt,
            snapshot,
        });
        recorded = true;
    }
    return recorded;
}

function recordSnapshotScalarObservation(
    state: DeviceManagerObservationState,
    snapshot: TargetDeviceSnapshot,
    params: {
        deviceId: string;
        capabilityId: 'measure_power' | 'evcharger_charging_state';
        value: number | string | undefined;
        source: CapabilityObservationSource;
        observedAt: number;
        capabilityIdSet: Set<string> | null;
    },
): boolean {
    const {
        deviceId,
        capabilityId,
        value,
        source,
        observedAt,
        capabilityIdSet,
    } = params;
    if (typeof value !== 'number' && typeof value !== 'string') return false;
    if (capabilityIdSet && !capabilityIdSet.has(capabilityId)) return false;
    recordCapabilityObservation({
        state,
        latestSnapshot: [],
        deviceId,
        capabilityId,
        value,
        source,
        observedAt,
        snapshot,
    });
    return true;
}

function updateLocalWriteTimestamps(
    state: DeviceManagerObservationState,
    latestSnapshot: TargetDeviceSnapshot[],
    deviceId: string,
    observedAt: number,
    snapshot?: TargetDeviceSnapshot,
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

function buildCapabilityObservationKey(deviceId: string, capabilityId: string): string {
    return `${deviceId}:${capabilityId}`;
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
