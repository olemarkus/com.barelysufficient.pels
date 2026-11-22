import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { SnapshotRefreshService } from './snapshotRefresh';
import type { TransportObservationState, WrittenSinceRead } from './transportObservationState';
import type { SnapshotRefreshOptions } from './transportTypes';
import type { DeviceFetchResult } from './managerFetch';
import { countRefreshRead } from './refreshWorkload';
import { normalizeError } from '../../utils/errorUtils';
import { getLogger } from '../../logging/logger';

const moduleLogger = getLogger('device/transport');

/**
 * What one refresh reads and confirms. `viewIds` are the views it reads
 * (`null` for a full read). A refresh that confirms PELS's writes reads only
 * the written views, or every known one after a command no write names
 * (`WrittenSinceRead`). Every read takes what was written since the last one,
 * since any read of a device also confirms what was written to it, and puts
 * back what it did not confirm (`restoreUnconfirmed`).
 */
export class TargetedReadScope {
    readonly viewIds: Set<string> | null;
    private readonly written: WrittenSinceRead;

    constructor(
        private readonly observations: TransportObservationState,
        private readonly sourceDeviceId: (viewId: string) => string,
        options: SnapshotRefreshOptions,
        previousSnapshot: readonly TransportDeviceSnapshot[],
        isTargetedRefresh: boolean,
    ) {
        this.written = observations.takeWrittenSinceRead();
        this.viewIds = isTargetedRefresh ? resolveViewIds(this.written, options, previousSnapshot) : null;
    }

    /**
     * Put back the writes this read took but did not confirm: all of them when
     * nothing was committed (`failedSourceIds` `null`), otherwise the written
     * views whose Homey device the read failed for. A command no write names is
     * put back whole when any device failed, since it may be the one it drove.
     */
    restoreUnconfirmed(failedSourceIds: readonly string[] | null): void {
        const { written } = this;
        if (failedSourceIds !== null && failedSourceIds.length === 0) return;
        if (failedSourceIds === null || written.kind === 'every_device') {
            this.observations.restoreWrittenSinceRead(written, written.kind === 'devices' ? written.ids : []);
            return;
        }
        const failed = new Set(failedSourceIds);
        const unconfirmed = written.ids.filter((id) => failed.has(this.sourceDeviceId(id)));
        this.observations.restoreWrittenSinceRead(written, unconfirmed);
    }
}

function resolveViewIds(
    written: WrittenSinceRead,
    options: SnapshotRefreshOptions,
    previousSnapshot: readonly TransportDeviceSnapshot[],
): Set<string> {
    const known = previousSnapshot.map((device) => device.id);
    if (options.writtenDevicesOnly !== true || written.kind === 'every_device') return new Set(known);
    const knownIds = new Set(known);
    const writtenKnown = written.ids.filter((id) => knownIds.has(id));
    return new Set(writtenKnown.length > 0 ? writtenKnown : known);
}

/** The read itself; a failed one puts back every write it took. */
export async function fetchDevicesForSnapshotRefresh(
    refresh: SnapshotRefreshService,
    readScope: TargetedReadScope,
): Promise<DeviceFetchResult | null> {
    const targetedViewIds = readScope.viewIds;
    const isTargetedRefresh = targetedViewIds !== null;
    try {
        const result = isTargetedRefresh
            ? await refresh.fetchDevicesByKnownIds(targetedViewIds)
            : await refresh.deviceSdk.fetchDevices();
        countRefreshRead(isTargetedRefresh, result.devices.length);
        return result;
    } catch (error) {
        readScope.restoreUnconfirmed(null);
        const normalizedError = normalizeError(error);
        moduleLogger.error({
            event: 'device_snapshot_refresh_failed',
            reasonCode: 'refresh_failed',
            targetedRefresh: isTargetedRefresh,
            err: normalizedError,
        });
        return null;
    }
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
