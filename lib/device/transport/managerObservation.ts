/* eslint-disable max-lines --
 * Observation tracking keeps freshness, retained observations, and debug source state together.
 */
/* eslint-disable max-params --
 * Internal helpers mirror observation fields directly to keep this move-only split simple.
 */
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { HomeyDeviceLike } from '../../utils/types';
import type { HandleRealtimeDeviceUpdateResult } from './managerRealtimeHandlers';
import type { DeviceFetchSource } from './managerFetch';
import { getDeviceId } from './managerHelpers';
import {
    resolveEvChargingStateBinaryEvidence,
    resolveEvCurrentOn,
} from '../managerControl';
import {
    EV_SOC_NATIVE_CAPABILITY_IDS,
    isStateOfChargeCapabilityId,
    updateStateOfChargeFromRealtimeCapability,
    updateStateOfChargeSessionBoundary,
} from './stateOfCharge';

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

export type DeviceTransportObservationState = {
    debugObservedSourcesByDeviceId: Map<string, DeviceDebugObservedSources>;
    capabilityObservations: Map<string, CapabilityObservation>;
    latestLocalWriteMsByDeviceId: Map<string, number>;
};

export function createObservationState(): DeviceTransportObservationState {
    return {
        debugObservedSourcesByDeviceId: new Map(),
        capabilityObservations: new Map(),
        latestLocalWriteMsByDeviceId: new Map(),
    };
}

export function getDebugObservedSources(
    state: DeviceTransportObservationState,
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
    state: DeviceTransportObservationState;
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
    state: DeviceTransportObservationState;
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
    state: DeviceTransportObservationState;
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
    state: DeviceTransportObservationState;
    previousSnapshot: TargetDeviceSnapshot[];
    nextSnapshot: TargetDeviceSnapshot[];
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

export function recordSnapshotCapabilityObservations(params: {
    state: DeviceTransportObservationState;
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
    const stateOfChargeCapabilityId = snapshot.stateOfCharge?.capabilityId;
    const observedStateOfChargeCapabilityId = stateOfChargeCapabilityId
        && isStateOfChargeCapabilityId(stateOfChargeCapabilityId)
        ? stateOfChargeCapabilityId
        : 'measure_battery';
    recordSnapshotScalarObservation(state, snapshot, {
        deviceId,
        capabilityId: observedStateOfChargeCapabilityId,
        value: snapshot.stateOfCharge?.percent,
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
    latestSnapshot: TargetDeviceSnapshot[];
    deviceId: string;
    capabilityId: string;
    value: unknown;
    source: CapabilityObservationSource;
    observedAt?: number;
    snapshot?: TargetDeviceSnapshot;
    countsTowardDeviceFreshness?: boolean;
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
        countsTowardDeviceFreshness = !isStateOfChargeCapabilityId(capabilityId),
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
    state: DeviceTransportObservationState,
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
    state: DeviceTransportObservationState;
    nextSnapshot: TargetDeviceSnapshot;
    previous: TargetDeviceSnapshot;
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
    previous: TargetDeviceSnapshot;
    snapshot: TargetDeviceSnapshot;
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
    snapshot: TargetDeviceSnapshot,
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
    snapshot: TargetDeviceSnapshot;
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
    state: DeviceTransportObservationState;
    deviceId: string;
    deviceName: string;
    capabilityId: string;
    sourceDevice: HomeyDeviceLike;
    nextSnapshot: TargetDeviceSnapshot;
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
    nextSnapshot: TargetDeviceSnapshot;
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
    if (isStateOfChargeCapabilityId(capabilityId)) {
        return applyStateOfChargeObservation(nextSnapshot, capabilityId, observation);
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
    const binaryEvidence = resolveEvChargingStateBinaryEvidence(observation.value);
    if (binaryEvidence !== undefined && observation.source !== 'local_write') {
        snapshot.binaryControlObservation = {
            valid: true,
            capabilityId: 'evcharger_charging',
            observedValue: binaryEvidence,
            observedCapabilityIds: ['evcharger_charging_state'],
            observedAtMs: observation.observedAt,
            source: observation.source,
        };
    } else {
        delete snapshot.binaryControlObservation;
    }
    updateStateOfChargeSessionBoundary({
        snapshot,
        evChargingState: observation.value,
        observedAtMs: observation.observedAt,
        nowMs: observation.observedAt,
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

function applyStateOfChargeObservation(
    nextSnapshot: TargetDeviceSnapshot,
    capabilityId: string,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    const changed = updateStateOfChargeFromRealtimeCapability({
        snapshot,
        capabilityId,
        value: observation.value,
        observedAtMs: observation.observedAt,
    });
    if (!changed) return false;
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
    state: DeviceTransportObservationState,
    deviceId: string,
    capabilityId: string,
    snapshot: TargetDeviceSnapshot,
): void {
    const key = buildCapabilityObservationKey(deviceId, capabilityId);
    const observation = state.capabilityObservations.get(key);
    if (!observation) return;
    if (isStateOfChargeCapabilityId(capabilityId)) {
        state.capabilityObservations.delete(key);
        return;
    }
    if (doesCapabilityObservationMatchSnapshot(snapshot, capabilityId, observation.value)) {
        state.capabilityObservations.delete(key);
    }
}

function doesCapabilityObservationMatchSnapshot(
    snapshot: TargetDeviceSnapshot,
    capabilityId: string,
    observationValue: unknown,
): boolean {
    if (capabilityId === snapshot.controlCapabilityId) {
        return matchesCurrentControlObservation(snapshot, observationValue);
    }
    if (capabilityId === 'measure_power') {
        return snapshot.measuredPowerKw === observationValue;
    }
    if (capabilityId === 'measure_temperature') {
        return snapshot.currentTemperature === observationValue;
    }
    if (capabilityId === 'evcharger_charging_state') {
        return snapshot.evChargingState === observationValue;
    }
    const target = snapshot.targets.find((entry) => entry.id === capabilityId);
    return target ? Object.is(target.value, observationValue) : false;
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
    state: DeviceTransportObservationState,
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
    state: DeviceTransportObservationState,
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
    state: DeviceTransportObservationState,
    snapshot: TargetDeviceSnapshot,
    params: {
        deviceId: string;
        capabilityId: 'measure_power' | 'evcharger_charging_state' | (typeof EV_SOC_NATIVE_CAPABILITY_IDS)[number];
        value: number | string | undefined;
        source: CapabilityObservationSource;
        observedAt: number;
        capabilityIdSet: Set<string> | null;
        countsTowardDeviceFreshness?: boolean;
    },
): boolean {
    const {
        deviceId,
        capabilityId,
        value,
        source,
        observedAt,
        capabilityIdSet,
        countsTowardDeviceFreshness = true,
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
        countsTowardDeviceFreshness,
    });
    return true;
}

function updateLocalWriteTimestamps(
    state: DeviceTransportObservationState,
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
