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
import { incPerfCounter } from '../../utils/perfCounters';
import { applyCapabilityObservation, clearCapabilityObservationIfMatched } from './observationApply';
import { preserveNewerReportedStepObservation } from './reportedStepObservation';

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
    // `lib/device/transport/managerParseSnapshot.ts`). That is the device's actual
    // liveness signal — Homey only advances `lastUpdated` when a capability genuinely
    // reported. A successful refresh poll is *not* by itself evidence the device
    // is alive: Homey serves cached capability values even when the device has
    // been silent for hours. Silence is not a fault, though — drivers only
    // republish on value change — so nothing ages an observation out. Only
    // `available === false` says a device is actually gone.
    for (let index = nextSnapshot.length - 1; index >= 0; index -= 1) {
        const snapshot = nextSnapshot[index];
        // The loop walks the array's own live indices, so this cannot miss.
        if (snapshot === undefined) continue;
        const previous = previousById.get(snapshot.id);
        const sourceDevice = devicesById.get(snapshot.id);
        if (!sourceDevice) continue;
        const hadTemperature = snapshot.temperature !== undefined;
        if (previous) {
            mergeSnapshotObservationsForDevice({
                state,
                nextSnapshot: snapshot,
                previous,
                sourceDevice,
                logger,
                debugStructured,
            });
        } else {
            mergeTemperatureRejectionObservations({
                state,
                snapshot,
                sourceDevice,
                logger,
            });
        }
        if (
            hadTemperature
            && snapshot.temperature === undefined
            && !snapshot.binaryCapabilityId
            && !snapshot.steppedLoadProfile
        ) {
            nextSnapshot.splice(index, 1);
        }
    }
}

function mergeTemperatureRejectionObservations(params: {
    state: DeviceTransportObservationState;
    snapshot: TransportDeviceSnapshot;
    sourceDevice: HomeyDeviceLike;
    logger: { debug: (...args: unknown[]) => void };
}): void {
    const { state, snapshot, sourceDevice, logger } = params;
    for (const capabilityId of ['target_temperature', 'measure_temperature'] as const) {
        const observation = state.capabilityObservations.get(
            buildCapabilityObservationKey(snapshot.id, capabilityId),
        );
        if (!observation || isFiniteNumber(observation.value)) continue;
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
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
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
    preserveNewerReportedStepObservation(previous, snapshot);

    if (snapshot.binaryCapabilityId) {
        mergeCapabilityObservation({
            state,
            deviceId: snapshot.id,
            deviceName: snapshot.name,
            capabilityId: snapshot.binaryCapabilityId,
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
    if (!nextObservation || nextObservation.observedAtMs < previousObservation.observedAtMs) {
        snapshot.binaryControlObservation = {
            ...previousObservation,
            observedCapabilityIds: [...previousObservation.observedCapabilityIds],
        };
    }
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
        ...(snapshot.binaryCapabilityId ? [snapshot.binaryCapabilityId] : []),
        ...snapshot.targets.map((target) => target.id),
    ];
    let max = 0;
    for (const capabilityId of capabilityIds) {
        const observation = state.capabilityObservations.get(
            buildCapabilityObservationKey(snapshot.id, capabilityId),
        );
        if (observation?.countsTowardDeviceFreshness) {
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
    const observationKey = buildCapabilityObservationKey(deviceId, capabilityId);
    const observation = state.capabilityObservations.get(observationKey);
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
    // value the observer consolidates them to whenever one source wins (the
    // two-source reconciliation we want visibility on); when both already agree
    // there is no reconciliation, so that case is counted instead. Both helpers
    // no-op for non-control capabilities.
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
        acceptFreshCapabilityPull({
            state,
            observationKey,
            capabilityId,
            fetchedValue,
            deviceId,
            nextSnapshot,
            observation,
            consolidationCtx,
        });
        return;
    }
    const shouldPreserveObservation = shouldPreserveRetainedObservation({
        source: observation.source,
        fetchedHasKnownFreshness,
        fetchedLastUpdatedMs,
        observedAt: observation.observedAt,
        preserveWithoutFetchedFreshness: isRejectedTemperatureObservation(capabilityId, observation),
    });
    if (!shouldPreserveObservation) {
        emitBinaryConsolidation(consolidationCtx, fetchedValue, 'pull', 'retained_not_preserved');
        return;
    }
    if (!applyCapabilityObservation(nextSnapshot, capabilityId, observation)) {
        recordBinaryConsolidationUnchanged(consolidationCtx);
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

function acceptFreshCapabilityPull(params: {
    state: DeviceTransportObservationState;
    observationKey: string;
    capabilityId: string;
    fetchedValue: unknown;
    deviceId: string;
    nextSnapshot: TransportDeviceSnapshot;
    observation: CapabilityObservation;
    consolidationCtx: ConsolidationContext;
}): void {
    const {
        state, observationKey, capabilityId, fetchedValue, deviceId,
        nextSnapshot, observation, consolidationCtx,
    } = params;
    emitBinaryConsolidation(consolidationCtx, fetchedValue, 'pull', 'pull_fresher_or_equal');
    if (isRejectedTemperatureObservation(capabilityId, observation) && isFiniteNumber(fetchedValue)) {
        state.capabilityObservations.delete(observationKey);
        return;
    }
    clearCapabilityObservationIfMatched(state, deviceId, capabilityId, nextSnapshot);
}

function isRejectedTemperatureObservation(
    capabilityId: string,
    observation: CapabilityObservation,
): boolean {
    const isTemperatureCapability = capabilityId === 'measure_temperature'
        || capabilityId === 'target_temperature';
    return isTemperatureCapability && !isFiniteNumber(observation.value);
}

function shouldPreserveRetainedObservation(params: {
    source: CapabilityObservationSource;
    fetchedHasKnownFreshness: boolean;
    fetchedLastUpdatedMs?: number;
    observedAt: number;
    preserveWithoutFetchedFreshness: boolean;
}): boolean {
    const {
        source, fetchedHasKnownFreshness, fetchedLastUpdatedMs, observedAt,
        preserveWithoutFetchedFreshness,
    } = params;
    if (preserveWithoutFetchedFreshness && !fetchedHasKnownFreshness) return true;
    const fetchedIsOlder = fetchedLastUpdatedMs !== undefined && fetchedLastUpdatedMs < observedAt;
    if (source === 'device_update') {
        return !fetchedHasKnownFreshness || fetchedIsOlder;
    }
    return fetchedHasKnownFreshness && fetchedIsOlder;
}

// Only a source that actually won carries a decision. The case where both
// sources already hold the same value is counted, not logged — see
// `recordBinaryConsolidationUnchanged`.
type ConsolidationWinner = 'pull' | 'retained';

type ConsolidationReason =
    | 'retained_not_preserved'
    | 'retained_fresher'
    | 'pull_fresher_or_equal'
    | 'retained_over_disagreeing_pull';

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

function isBinaryControlConsolidation(ctx: ConsolidationContext): boolean {
    return ctx.capabilityId === ctx.nextSnapshot.binaryCapabilityId;
}

/**
 * The retained observation left the snapshot unchanged. That is not on its own
 * an agreement, so the two sources are compared before one is claimed.
 *
 * When they hold the same value nothing was reconciled and there is no decision
 * to record — the steady state of a working merge, not an event. When they do
 * not, the snapshot is unchanged for the opposite reason: the pull carried
 * something the parse seam would not take (a malformed `onoff`, or none at all)
 * and the retained observation is what stands. That IS a decision, and the
 * payload's `pull` field is the only place the mismatch is visible, so it keeps
 * its line.
 *
 * The comparison costs nothing: across one 16 h production window all 3,088
 * agreeing lines carried `pull.value === retained.value`, so the guard reintroduces
 * no volume while keeping `binary_observation_agreed_total` honest.
 *
 * The mirror case — a retained observation that is not a boolean — needs no
 * check here. `applyControlCapabilityObservation` refuses one, but none can be
 * retained: the realtime path diverts a non-boolean control payload before it is
 * ever recorded, `device_update` records malformed temperature entries only, and
 * a local write stores PELS's own normalized boolean. Re-deriving that guard is
 * the hedge `AGENTS.md` § "Clean and trusted interfaces" rules out.
 *
 * Agreement is counted rather than logged. All 3,088 lines in that window were
 * this case — 1.36 MB, 6% of structured stdout — and not one recorded a choice
 * between the two sources. The counter keeps "the merge ran and the sources
 * agreed" visible in `perf_counters`, where it costs one map entry per window
 * instead of ~440 bytes per observation.
 */
function recordBinaryConsolidationUnchanged(ctx: ConsolidationContext): void {
    if (!isBinaryControlConsolidation(ctx)) return;
    if (ctx.fetchedValue !== ctx.observation.value) {
        emitBinaryConsolidation(
            ctx,
            ctx.observation.value,
            'retained',
            'retained_over_disagreeing_pull',
        );
        return;
    }
    incPerfCounter('binary_observation_agreed_total');
}

function emitBinaryConsolidation(
    ctx: ConsolidationContext,
    consolidatedValue: unknown,
    winner: ConsolidationWinner,
    reason: ConsolidationReason,
): void {
    if (!isBinaryControlConsolidation(ctx)) return;
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
