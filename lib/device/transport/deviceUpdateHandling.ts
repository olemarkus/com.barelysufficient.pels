/**
 * Whole-device realtime update handling for `DeviceTransport`, extracted as
 * homey-free free functions over a shared `RealtimeIngestService`. Reconciles a
 * pushed `device.update` against the held snapshot (binary-settle evidence,
 * native stepped-load adapters, calibration-input detection) and defers the
 * observed-state emission until the snapshot commit is in place.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import { isIgnoredDeviceRead } from './deviceReadContract';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceId } from './managerHelpers';
import { getDebugEmitter, getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import {
  recordDeviceUpdateObservation,
  recordSnapshotCapabilityObservations,
} from './managerObservation';
import {
  handleRealtimeDeviceUpdate as runRealtimeDeviceUpdate,
  type ObservedDeviceStateEvent,
  type PlanRealtimeUpdateEvent,
} from './managerRealtimeHandlers';
import { buildNativeEvObservationDevice } from '../nativeEvWiring';
import { MIN_SIGNIFICANT_POWER_W } from './transportTypes';
import type { RealtimeIngestService } from './transportServices';
import type { SnapshotRefreshService } from './snapshotRefresh';
import type { TransportSnapshotStore } from './transportSnapshotStore';

const moduleLogger = getLogger('device/transport');
const emitDeviceDebug = getDebugEmitter('devices', 'devices');

export function didSnapshotChangeCalibrationInputs(params: {
    previousSnapshot: TransportDeviceSnapshot | undefined;
    currentSnapshot: TransportDeviceSnapshot;
    observedCapabilityIds: readonly string[];
}): boolean {
    const { previousSnapshot, currentSnapshot, observedCapabilityIds } = params;
    if (observedCapabilityIds.includes('measure_power')) return true;
    if (!previousSnapshot) {
        return typeof currentSnapshot.measuredPowerKw === 'number'
            || typeof currentSnapshot.reportedStepId === 'string';
    }
    if (!Object.is(previousSnapshot.measuredPowerKw, currentSnapshot.measuredPowerKw)) return true;
    if (previousSnapshot.reportedStepId !== currentSnapshot.reportedStepId) return true;
    return false;
}

export function fireSnapshotMutatedForRefresh(
    refresh: SnapshotRefreshService,
    snapshot: readonly TransportDeviceSnapshot[],
    previousSnapshot: readonly TransportDeviceSnapshot[],
): void {
    const previousByDeviceId = new Map(previousSnapshot.map((entry) => [entry.id, entry]));
    const nowMs = Date.now();
    for (const entry of snapshot) {
        if (didSnapshotChangeCalibrationInputs({
            previousSnapshot: previousByDeviceId.get(entry.id),
            currentSnapshot: entry,
            observedCapabilityIds: [],
        })) {
            refresh.notifications.snapshotChanged(entry, nowMs);
        }
    }
}

function syncRealtimeDeviceUpdateSnapshot(
    snapshotStore: TransportSnapshotStore,
    deviceId: string,
    currentSnapshot: TargetDeviceSnapshot | null | undefined,
): TargetDeviceSnapshot | null {
    if (currentSnapshot === undefined) return null;
    if (currentSnapshot) {
        snapshotStore.replaceSnapshotEntry(deviceId, currentSnapshot);
        return currentSnapshot;
    }
    snapshotStore.removeSnapshotEntry(deviceId);
    return null;
}

// Realtime zone move: the replacement entry carries a different `zoneId` than
// the one it replaced (or the device first appeared with a zone via the
// realtime path). Called AFTER the snapshot commit so the membership recompute
// this triggers reads the NEW zone; contained, so a subscriber throw never
// surfaces on the realtime event path (parity with the zone-tree-commit
// notify in `snapshotRefresh.ts`).
function notifyDeviceZoneChangeContained(
    ingest: RealtimeIngestService,
    previousSnapshot: { zoneId?: string | null } | undefined,
    currentSnapshot: { zoneId?: string | null } | null,
): void {
    if (!currentSnapshot) return;
    if ((previousSnapshot?.zoneId ?? null) === (currentSnapshot.zoneId ?? null)) return;
    try {
        ingest.notifications.notifyDeviceZoneChanged();
    } catch (error) {
        emitDeviceDebug({
            event: 'device_zone_changed_notify_failed',
            error: normalizeError(error).message,
        });
    }
}

export function handleRealtimeDeviceUpdateEvent(ingest: RealtimeIngestService, device: HomeyDeviceLike): void {
    const deviceId = getDeviceId(device);
    if (deviceId && !ingest.reader.shouldTrackRealtimeDevice(deviceId)) {
        ingest.binaryEvidence.clearBinarySettleEvidence(deviceId);
        ingest.reader.snapshotStore.untrackRawDevice(deviceId);
    }
    const effectiveDevice = ingest.reader.applyDeviceDriverOverride(device);
    // The read contract (`deviceReadContract.ts`), before anything reads the
    // payload: an update that does not conform is ignored whole. No producer,
    // tracking entry, parse or settle evidence sees it, and the device's entry
    // stands as it was — a no-op, never a partial merge.
    const contractEmitter = moduleLogger;
    if (isIgnoredDeviceRead(ingest.reader.snapshotStore, effectiveDevice, 'device_update', contractEmitter)) return;
    // Keep the battery membership set non-empty for a present battery even before
    // the first full refresh — the realtime path parses the battery (stamped
    // managed observe-only structurally), so the deviceId-only resolve* consumers
    // must agree. Additive: a full refresh re-derives the set; this never narrows it.
    ingest.observationProducers.battery.noteBatteryDevice(effectiveDevice);
    // Same machinery for a present solar device: keep the solar membership set
    // non-empty before the first full refresh so the deviceId-only resolve* consumers
    // agree with the structural managed observe-only stamp. Additive; full refresh
    // re-derives the set.
    ingest.observationProducers.solar.noteSolarDevice(effectiveDevice);
    const previousSnapshot = ingest.reader.snapshotStore.getSnapshotIndex().get(deviceId);
    if (deviceId && ingest.reader.shouldTrackRealtimeDevice(deviceId)) {
        ingest.reader.snapshotStore.trackRawDevice(deviceId, effectiveDevice);
        ingest.reader.syncNativeSteppedLoadCommandAdapters();
    }
    const observedDevice = buildNativeEvObservationDevice({
        device: effectiveDevice,
        previousSnapshot,
    });
    // Defer the observed-state emission until AFTER the snapshot commit
    // below. `dispatchObservedStateChanged` enriches the event by projecting
    // `latestSnapshotById`, so emitting inline here would project the
    // PRE-update snapshot and lag the projection one device-update behind
    // (Codex P2 on PR-4a). Collect now, dispatch once the committed snapshot
    // (incl. binary-settle evidence) is in place.
    const deferredObservedStateEvents: ObservedDeviceStateEvent[] = [];
    const deferredControlEvents: PlanRealtimeUpdateEvent[] = [];
    const result = runRealtimeDeviceUpdate({
        device: observedDevice,
        latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
        observationState: ingest.observationBridge.state,
        shouldTrackRealtimeDevice: (nextDeviceId) => ingest.reader.shouldTrackRealtimeDevice(nextDeviceId),
        parseDevice: (nextDevice, nowTs) => ingest.reader.parseDevice(nextDevice, nowTs, {}),
        minSignificantPowerW: MIN_SIGNIFICANT_POWER_W,
        recordObservedCapabilities: (nextDeviceId, capabilityIds) => {
            recordSnapshotCapabilityObservations({
                state: ingest.observationBridge.state.getObservationState(),
                latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
                deviceId: nextDeviceId,
                source: 'device_update',
                capabilityIds,
            });
        },
        emitDeviceUpdateProcessed: (event) => {
          emitDeviceDebug(event);
        },
        createObservationCursor: (nextDeviceId) => ingest.observationBridge.nextCursor(nextDeviceId),
        // Call-local queues defer events until the snapshot commit.
        /* eslint-disable functional/immutable-data */
        emitObservedControlStateChanged: (event) => deferredControlEvents.push(event),
        emitObservedState: (event: ObservedDeviceStateEvent) => deferredObservedStateEvents.push(event),
        /* eslint-enable functional/immutable-data */
    });
    const currentSnapshot = deviceId
        ? syncRealtimeDeviceUpdateSnapshot(ingest.reader.snapshotStore, deviceId, result.currentSnapshot)
        : null;
    if (deviceId) {
        ingest.binaryEvidence.applyFromDeviceUpdate({
            deviceId,
            device: observedDevice,
            snapshot: currentSnapshot,
            previousSnapshot,
        });
    }
    if (deviceId && result.observedControlStateChanged) {
        recordDeviceUpdateObservation({
            state: ingest.observationBridge.state.getObservationState(),
            latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
            deviceId,
            result,
        });
    }
    if (currentSnapshot && didSnapshotChangeCalibrationInputs({
        previousSnapshot,
        currentSnapshot,
        observedCapabilityIds: result.observedCapabilityIds,
    })) {
        ingest.notifications.snapshotChanged(currentSnapshot, Date.now());
    }
    notifyDeviceZoneChangeContained(ingest, previousSnapshot, currentSnapshot);
    // Snapshot (and binary-settle evidence) is now committed to
    // `latestSnapshotById`, so each enriched observed value projects the
    // post-update state rather than the previous one.
    flushDeferredObservedState(ingest, deviceId, deferredObservedStateEvents, previousSnapshot, currentSnapshot);
    for (const event of deferredControlEvents) ingest.observationBridge.emitControlStateChanged(event);
    // Class `car` devices reach us only here and on the device fetch: the live
    // feed pushes `device.update` for EVERY device, while parse drops unsupported
    // classes. Passed every update, not just cars — a charger's own update is what
    // timestamps its plug edge correctly. Inert while no car is tracked.
    //
    // Deliberately AFTER the snapshot commit, for the same reason as the
    // observed-state dispatch above: the probe resolves charger state by reading
    // the committed snapshot, so running it earlier would diff against the
    // PRE-update state and lag every charger edge by one device update.
    ingest.observationProducers.evCarLink.noteDeviceUpdate(effectiveDevice, Date.now());
}

// Dispatch the reconcile's deferred observed-state events — and when it emitted
// none, still dispatch for an availability flip. Availability is not a
// capability, so it has no per-capability event of its own: it changes only
// here, when the re-parsed device replaces the entry, and the reconcile emits an
// observation event only for a control-state change or a temperature /
// state-of-charge facet. A device.update that ONLY flips `available` would
// otherwise leave the projection reporting the old value until the next full
// refresh — and the executor reads `available` from the projection (stage 5 of
// the snapshot decomposition), so it would keep writing to a device Homey had
// marked unreachable, or skip one that had come back, for up to that long.
// Called AFTER the commit, like every dispatch on this path.
function flushDeferredObservedState(
    ingest: RealtimeIngestService,
    deviceId: string,
    events: readonly ObservedDeviceStateEvent[],
    previousSnapshot: Pick<TargetDeviceSnapshot, 'available'> | undefined,
    currentSnapshot: Pick<TargetDeviceSnapshot, 'available'> | null,
): void {
    for (const event of events) ingest.observationBridge.dispatchStateChanged(event);
    if (events.length > 0 || !currentSnapshot) return;
    if (previousSnapshot?.available === currentSnapshot.available) return;
    ingest.observationBridge.dispatchStateForDevice(deviceId);
}
