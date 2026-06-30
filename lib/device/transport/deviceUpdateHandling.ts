/**
 * Whole-device realtime update handling for `DeviceTransport`, extracted as
 * homey-free free functions over a shared `TransportContext`. Reconciles a
 * pushed `device.update` against the held snapshot (binary-settle evidence,
 * native stepped-load adapters, calibration-input detection) and defers the
 * observed-state emission until the snapshot commit is in place.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceId } from './managerHelpers';
import { getLogger } from '../../logging/logger';
import {
  recordDeviceUpdateObservation,
  recordSnapshotCapabilityObservations,
} from './managerObservation';
import {
  handleRealtimeDeviceUpdate as runRealtimeDeviceUpdate,
  type ObservedDeviceStateEvent,
} from './managerRealtimeHandlers';
import { buildNativeEvObservationDevice } from '../nativeEvWiring';
import { MIN_SIGNIFICANT_POWER_W } from './transportTypes';
import {
  applyBinarySettleEvidenceFromDeviceUpdate,
  clearBinarySettleEvidence,
  clearInvalidBinarySettleEvidenceFromDeviceUpdate,
} from './binarySettleEvidence';
import type { TransportContext } from './transportContext';

const moduleLogger = getLogger('device/transport');

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
    ctx: TransportContext,
    snapshot: readonly TransportDeviceSnapshot[],
    previousSnapshot: readonly TransportDeviceSnapshot[],
): void {
    if (!ctx.onSnapshotMutated) return;
    const previousByDeviceId = new Map(previousSnapshot.map((entry) => [entry.id, entry]));
    const nowMs = Date.now();
    for (const entry of snapshot) {
        if (didSnapshotChangeCalibrationInputs({
            previousSnapshot: previousByDeviceId.get(entry.id),
            currentSnapshot: entry,
            observedCapabilityIds: [],
        })) {
            ctx.onSnapshotMutated(entry, nowMs);
        }
    }
}

function syncRealtimeDeviceUpdateSnapshot(ctx: TransportContext, params: {
    deviceId: string;
    currentSnapshot: TargetDeviceSnapshot | null | undefined;
    previousSnapshot: TargetDeviceSnapshot | undefined;
    preservePreviousSnapshot: boolean;
}): TargetDeviceSnapshot | null {
    const {
        deviceId,
        currentSnapshot,
        previousSnapshot,
        preservePreviousSnapshot,
    } = params;
    if (currentSnapshot === undefined) return null;
    if (currentSnapshot) {
        ctx.latestSnapshotById.set(deviceId, currentSnapshot);
        return currentSnapshot;
    }
    if (preservePreviousSnapshot && previousSnapshot) {
        if (!ctx.latestSnapshot.some((snapshot) => snapshot.id === deviceId)) {
            ctx.latestSnapshot.push(previousSnapshot);
        }
        ctx.latestSnapshotById.set(deviceId, previousSnapshot);
        return previousSnapshot;
    }
    ctx.latestSnapshotById.delete(deviceId);
    return null;
}

export function handleRealtimeDeviceUpdateEvent(ctx: TransportContext, device: HomeyDeviceLike): void {
    const deviceId = getDeviceId(device);
    if (deviceId && !ctx.shouldTrackRealtimeDevice(deviceId)) {
        clearBinarySettleEvidence(ctx, deviceId);
        ctx.deleteTrackedDevice(deviceId);
    }
    const effectiveDevice = ctx.applyDeviceDriverOverride(device);
    // Keep the battery membership set non-empty for a present battery even before
    // the first full refresh — the realtime path parses the battery (stamped
    // managed observe-only structurally), so the deviceId-only resolve* consumers
    // must agree. Additive: a full refresh re-derives the set; this never narrows it.
    ctx.batteryStateProducer.noteBatteryDevice(effectiveDevice);
    // Same machinery for a present solar device: keep the solar membership set
    // non-empty before the first full refresh so the deviceId-only resolve* consumers
    // agree with the structural managed observe-only stamp. Additive; full refresh
    // re-derives the set.
    ctx.solarProductionProducer.noteSolarDevice(effectiveDevice);
    const previousSnapshot = ctx.latestSnapshotById.get(deviceId);
    const binarySafeUpdate = deviceId
        ? clearInvalidBinarySettleEvidenceFromDeviceUpdate(ctx, deviceId, effectiveDevice, previousSnapshot)
        : { device: effectiveDevice, hadInvalidBinaryControlPayload: false };
    const { device: binarySafeDevice, hadInvalidBinaryControlPayload } = binarySafeUpdate;
    if (deviceId && ctx.shouldTrackRealtimeDevice(deviceId)) {
        ctx.setTrackedDevice(deviceId, binarySafeDevice);
        ctx.syncTrackedNativeSteppedLoadAdapters();
    }
    const observedDevice = buildNativeEvObservationDevice({
        device: binarySafeDevice,
        previousSnapshot,
    });
    // Defer the observed-state emission until AFTER the snapshot commit
    // below. `dispatchObservedStateChanged` enriches the event by projecting
    // `latestSnapshotById`, so emitting inline here would project the
    // PRE-update snapshot and lag the projection one device-update behind
    // (Codex P2 on PR-4a). Collect now, dispatch once the committed snapshot
    // (incl. binary-settle evidence) is in place.
    const deferredObservedStateEvents: ObservedDeviceStateEvent[] = [];
    const result = runRealtimeDeviceUpdate({
        device: observedDevice,
        latestSnapshot: ctx.latestSnapshot,
        recentLocalCapabilityWrites: ctx.recentLocalCapabilityWrites,
        shouldTrackRealtimeDevice: (nextDeviceId) => ctx.shouldTrackRealtimeDevice(nextDeviceId),
        parseDevice: (nextDevice, nowTs) => ctx.parseDevice(nextDevice, nowTs, {}),
        minSignificantPowerW: MIN_SIGNIFICANT_POWER_W,
        recordObservedCapabilities: (nextDeviceId, capabilityIds) => {
            recordSnapshotCapabilityObservations({
                state: ctx.observationState,
                latestSnapshot: ctx.latestSnapshot,
                deviceId: nextDeviceId,
                source: 'device_update',
                capabilityIds,
            });
        },
        notePendingBinarySettleObservation: (nextDeviceId, capabilityId, value, source, ensureEventFields) => (
            ctx.binarySettleOps.note({
                state: ctx.binarySettleState,
                deps: ctx.getBinarySettleDeps(),
                deviceId: nextDeviceId,
                capabilityId,
                value,
                source,
                ensureEventFields,
            })
        ),
        hasPendingBinarySettleWindow: (nextDeviceId, capabilityId) => (
            ctx.consultPendingPredicate(nextDeviceId, capabilityId)
        ),
        emitDeviceUpdateProcessed: (event) => {
          const emit = ctx.debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p));
          emit(event);
        },
        createObservationCursor: (nextDeviceId) => ctx.nextObservationCursor(nextDeviceId),
        emitPlanReconcile: (event) => ctx.emitPlanReconcileEvent(event),
        emitObservedState: (event: ObservedDeviceStateEvent) => deferredObservedStateEvents.push(event),
    });
    const currentSnapshot = deviceId
        ? syncRealtimeDeviceUpdateSnapshot(ctx, {
            deviceId,
            currentSnapshot: result.currentSnapshot,
            previousSnapshot,
            preservePreviousSnapshot: hadInvalidBinaryControlPayload,
        })
        : null;
    if (deviceId) {
        applyBinarySettleEvidenceFromDeviceUpdate(ctx, {
            deviceId,
            device: observedDevice,
            snapshot: currentSnapshot,
            previousSnapshot,
            skipInvalidControlPayload: hadInvalidBinaryControlPayload,
        });
    }
    if (deviceId && result.hadChanges) {
        recordDeviceUpdateObservation({
            state: ctx.observationState,
            latestSnapshot: ctx.latestSnapshot,
            deviceId,
            result,
        });
    }
    if (currentSnapshot && didSnapshotChangeCalibrationInputs({
        previousSnapshot,
        currentSnapshot,
        observedCapabilityIds: result.observedCapabilityIds,
    })) {
        ctx.onSnapshotMutated?.(currentSnapshot, Date.now());
    }
    // Snapshot (and binary-settle evidence) is now committed to
    // `latestSnapshotById`, so each enriched observed value projects the
    // post-update state rather than the previous one.
    for (const event of deferredObservedStateEvents) {
        ctx.dispatchObservedStateChanged(event);
    }
}
