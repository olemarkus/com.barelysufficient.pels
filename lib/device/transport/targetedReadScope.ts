import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { SnapshotRefreshService } from './snapshotRefresh';
import type { SnapshotRefreshOptions } from './transportTypes';

/**
 * The views a targeted refresh reads, or `null` for a full read. A refresh that
 * confirms PELS's writes reads only the written views; every read takes the
 * written set, since any read of a device also confirms what was written to it.
 */
export function resolveTargetedViewIds(
    refresh: SnapshotRefreshService,
    options: SnapshotRefreshOptions,
    previousSnapshot: readonly TransportDeviceSnapshot[],
    isTargetedRefresh: boolean,
): Set<string> | null {
    const written = refresh.observationBridge.state.takeWrittenDeviceIds();
    if (!isTargetedRefresh) return null;
    const known = previousSnapshot.map((device) => device.id);
    if (options.writtenDevicesOnly !== true) return new Set(known);
    const knownIds = new Set(known);
    const writtenKnown = written.filter((id) => knownIds.has(id));
    return new Set(writtenKnown.length > 0 ? writtenKnown : known);
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function appendRecoveredTemperatureDevices(
    refresh: SnapshotRefreshService,
    presentSnapshot: readonly TransportDeviceSnapshot[],
    committedSnapshot: TransportDeviceSnapshot[],
): void {
    const pendingIds = new Set(refresh.temperatureRecovery.getPendingDeviceIds());
    const committedIds = new Set(committedSnapshot.map((device) => device.id));
    for (const device of presentSnapshot) {
        if (!pendingIds.has(device.id) || committedIds.has(device.id)) continue;
        committedSnapshot.push(device);
    }
}
/* eslint-enable functional/immutable-data */
