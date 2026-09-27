/**
 * Pull refresh pipeline for `DeviceTransport`, extracted as homey-free
 * functions owned by `SnapshotRefreshService`. It coordinates device fetches,
 * live power reads, battery/solar role detection, parsing, fresher-wins observation
 * merge, the empty-snapshot + targeted-miss abandon-grace logic, the snapshot
 * commit + refresh-event dispatch, and the post-commit device-list adoption.
 *
 * `SnapshotRefreshService` holds the collaborators for this workflow. Parsing
 * and raw-device tracking belong to `DeviceSnapshotReader`; commit, observation
 * and refresh lifecycle remain with their owners.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import { observeBatteryStateFromList, observeEvCarLinkAndResubscribe } from './refreshProducers';
import {
    partitionConformingDeviceReads,
    withIgnoredReadEntries,
    withIgnoredReadRawDevices,
} from './ignoredDeviceReads';
import type {
  TargetDeviceSnapshot,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import type { TransportSnapshotStore } from './transportSnapshotStore';
export { SnapshotRefreshState } from './snapshotRefreshState';
import { updateHomePowerFromReport, type HomePowerSampleWithIdentity } from './resolvedHomeMeterDispatch';
export type { HomePowerSampleWithIdentity } from './resolvedHomeMeterDispatch';
import {
  SNAPSHOT_ABANDON_GRACE_MS,
  SNAPSHOT_ABANDON_GRACE_READS,
  mergeTargetedRefreshSnapshot,
  overlayRetainedTrackedDevices,
} from './targetedSnapshotMerge';
import { addPerfDuration } from '../../utils/perfCounters';
import { startRuntimeSpan } from '../../utils/runtimeTrace';
import { logEvSnapshotChanges } from '../managerControl';
import { type LiveDevicePowerWatts } from '../managerEnergy';
export {
  fetchLiveGenerationW,
  type LiveGenerationRead,
} from './managerFetch';
export type { DeviceFetchResult } from './managerFetch';
import {
  type DeviceFetchSource,
} from './managerFetch';
import type { DeviceFetchResult } from './managerFetch';
import { fetchLivePowerReport } from './livePowerReport';
import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
export { pollHomePowerWithMeterFanOut } from './homePowerPoll';
import { fetchZoneTree } from './managerZones';
import { getDebugEmitter, getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import {
  mergeFresherCapabilityObservations,
  recordSnapshotRefreshObservations,
} from './managerObservation';
import {
  summarizeSnapshotRefreshMetrics,
  type SnapshotRefreshMetrics,
  type SnapshotRefreshOptions,
} from './transportTypes';
import { fireSnapshotMutatedForRefresh } from './deviceUpdateHandling';
import { DeviceSnapshotReader } from './deviceSnapshotReader';
import type { DeviceHomeySdk } from './deviceHomeySdk';
import type { SnapshotCommit } from './snapshotCommit';
import type { SnapshotRefreshState } from './snapshotRefreshState';
import type { ObservationBridge } from './observationBridge';
import type { ObservationProducers } from '../observationProducers';
import type { TemperatureRecoveryService } from './temperatureRecovery';
import type { TransportNotifications } from './transportNotifications';

const moduleLogger = getLogger('device/transport');
const emitDeviceDebug = getDebugEmitter('devices', 'devices');

// Homey SDK device reads can transiently return an empty list without throwing
// (see lib/device/transport/managerFetch.ts, which normalizes `[]`/`{}` into an
// empty list and returns successfully — so the fetch retry loop never engages).
// Treating a single empty read as authoritative would clobber a populated
// snapshot. Mirror the abandon-grace pattern in
// lib/objectives/deferredObjectives/planHistory.ts: only accept an empty
// snapshot once it has persisted for a grace window OR across enough consecutive
// reads, so a genuinely-emptied home still commits but a transient blip does not.
// The numerics are shared with the per-device targeted-miss grace (one source of
// truth in `targetedSnapshotMerge`).
const EMPTY_SNAPSHOT_ABANDON_GRACE_MS = SNAPSHOT_ABANDON_GRACE_MS;
const EMPTY_SNAPSHOT_ABANDON_GRACE_READS = SNAPSHOT_ABANDON_GRACE_READS;

/**
 * Guards against a transient empty SDK read clobbering a populated snapshot.
 *
 * `fetchDevicesWithFallback` normalizes an empty `getRawDevices` result into a
 * successful empty list, so the retry loop never engages. If we committed that
 * unconditionally, `setSnapshot([])` would wipe a previously-populated snapshot.
 *
 * Returns `true` (defer the commit) while the empty result is still within the
 * abandon-grace window AND under the consecutive-read threshold. Once either is
 * exceeded — a genuinely-emptied home — the empty snapshot is allowed through.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
function shouldDeferEmptySnapshotCommit(
    refresh: SnapshotRefreshService,
    snapshot: readonly TargetDeviceSnapshot[],
    previousSnapshot: readonly TargetDeviceSnapshot[],
    rawWasEmpty: boolean,
    nowMs: number,
): boolean {
    // Only an empty *raw* SDK read is the transient blip worth masking. If the
    // SDK returned devices but they all parsed/filtered out (e.g. nothing is
    // managed/eligible anymore), that is an intentional empty snapshot and must
    // commit immediately — deferring it would keep controlling a now-stale device
    // until the grace window or read threshold elapses.
    if (snapshot.length > 0 || previousSnapshot.length === 0 || !rawWasEmpty) {
        refresh.refreshState.setEmptySnapshotGrace(null);
        return false;
    }
    const grace = refresh.refreshState.getEmptySnapshotGrace() ?? {
        firstSeenMs: nowMs,
        reads: 0,
    };
    grace.reads += 1;
    refresh.refreshState.setEmptySnapshotGrace(grace);
    const elapsedMs = nowMs - grace.firstSeenMs;
    if (elapsedMs >= EMPTY_SNAPSHOT_ABANDON_GRACE_MS
        || grace.reads >= EMPTY_SNAPSHOT_ABANDON_GRACE_READS) {
        moduleLogger.warn({
            component: 'devices',
            event: 'device_snapshot_empty_grace_exceeded',
            reasonCode: 'empty_snapshot_committed',
            consecutiveEmptyReads: grace.reads,
            graceElapsedMs: elapsedMs,
            previousDevicesTotal: previousSnapshot.length,
        });
        refresh.refreshState.setEmptySnapshotGrace(null);
        return false;
    }
    moduleLogger.warn({
        component: 'devices',
        event: 'device_snapshot_empty_deferred',
        reasonCode: 'empty_snapshot_transient',
        consecutiveEmptyReads: grace.reads,
        graceElapsedMs: elapsedMs,
        previousDevicesTotal: previousSnapshot.length,
    });
    return true;
}
/* eslint-enable functional/immutable-data */

/**
 * Resolve the snapshot to commit. For a TARGETED (by-id) overlay, `failedIds`
 * is the set of ids whose NETWORK read failed this cycle: overlay onto the
 * prior snapshot via the per-device miss grace (`mergeTargetedRefreshSnapshot`)
 * — a network-missed device is RETAINED with its prior entry (stays planned,
 * keeps its plan state, stays in the targeted set so it is retried, ages via
 * the staleness backstop), while a device that was fetched fine but parsed out
 * is dropped immediately. A FULL read passes `failedIds = null` — authoritative,
 * take it wholesale and reset the miss state. The committed snapshot is always
 * complete truth for the known device set, so the projection prunes to match.
 */
function resolveCommittedRefreshSnapshot(
    refresh: SnapshotRefreshService,
    presentSnapshot: TransportDeviceSnapshot[],
    previousSnapshot: readonly TransportDeviceSnapshot[],
    failedIds: readonly string[] | null,
    nowMs: number,
): TransportDeviceSnapshot[] {
    if (failedIds === null) {
        refresh.refreshState.getTargetedMisses().clear();
        return presentSnapshot;
    }
    const { snapshot, graceExceededIds } = mergeTargetedRefreshSnapshot({
        presentSnapshot,
        previousSnapshot,
        failedIds,
        missByDeviceId: refresh.refreshState.getTargetedMisses(),
        nowMs,
    });
    appendRecoveredTemperatureDevices(refresh, presentSnapshot, snapshot);
    for (const deviceId of graceExceededIds) {
        moduleLogger.warn({
            component: 'devices',
            event: 'targeted_device_miss_grace_exceeded',
            deviceId,
        });
    }
    return snapshot;
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
function appendRecoveredTemperatureDevices(
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

/**
 * Commits a refreshed snapshot unless the abandon-grace guard defers it.
 * Returns `true` when committed, `false` when a transient empty read was held
 * back so the caller can skip the post-commit recording/logging.
 */
function commitRefreshedSnapshot(refresh: SnapshotRefreshService, params: {
    snapshot: TargetDeviceSnapshot[];
    previousSnapshot: readonly TargetDeviceSnapshot[];
    rawWasEmpty: boolean;
    nowMs: number;
}): boolean {
    const { snapshot, previousSnapshot, rawWasEmpty, nowMs } = params;
    if (shouldDeferEmptySnapshotCommit(refresh, snapshot, previousSnapshot, rawWasEmpty, nowMs)) return false;
    refresh.snapshotCommit.commit(snapshot);
    // Warm iff this read returned at least one RAW device, re-judged on every
    // full commit. With no previous snapshot the guard above commits an empty
    // raw read at once (nothing to clobber), so that commit cannot prove the
    // SDK answered: a real Homey always lists at least its meter, and an empty
    // raw list is the transient blip `fetchDevicesWithFallback` normalizes into
    // success. An empty streak that outlasts the grace commits `[]` and goes
    // cold for the same reason. Devices that all filtered out (none managed)
    // still count — the SDK spoke.
    refresh.refreshState.markWarm(!rawWasEmpty);
    // After setSnapshot so latestSnapshotById is current. The grace-deferred
    // path returns above (before setSnapshot), so the abandon-grace invariant
    // — no refresh event on a deferred empty read — holds by construction.
    refresh.observationBridge.dispatchStateRefresh(snapshot);
    refresh.temperatureRecovery.completeAfterRefresh();
    // Managed devices PLUS the cars the EV car-link probe tracks. Per-device
    // capability subscriptions (`homey:device:<id>`) are the ONLY realtime source
    // of capability VALUE changes; the manager-level `device.update` stream does
    // not carry them. A class `car` device never survives parse, so without this
    // union the probe would never see a plug transition in realtime and would be
    // limited to the device poll — far coarser than its 90 s coincidence window.
    refresh.deviceSdk.updateTrackedDevices([
        ...snapshot.map((d) => d.id),
        ...refresh.observationProducers.evCarLink.getObservedCarDeviceIds(),
    ]);
    fireSnapshotMutatedForRefresh(refresh, snapshot, previousSnapshot);
    return true;
}

function shouldEmitSnapshotRefreshLog(
    refresh: SnapshotRefreshService,
    devicesTotal: number,
    metrics: SnapshotRefreshMetrics,
): boolean {
    const nextKey = [
        devicesTotal,
        metrics.availableDevices,
        metrics.temperatureKnownDevices,
        metrics.temperatureUnknownDevices,
        metrics.unavailableDevices,
    ].join(':');
    return !refresh.refreshState.hasEmittedMetrics(nextKey);
}

// Adopt the side effects of a committed snapshot: rebuild the tracking map /
// native adapters and refresh the raw-device cache. Run only after the
// abandon-grace guard commits, so a deferred transient empty read leaves the
// previously-tracked devices, their native adapters, and the raw cache intact.
//
// Keyed off `fetchSource` (NOT the requested-targeted flag): a FULL read
// (`raw_manager_devices`, whether intended-full OR a targeted refresh that
// fell back to full) is authoritative — refresh `latestRawDevices` so the UI
// picker doesn't show a stale list. A genuine targeted overlay
// (`targeted_by_id`) may retain a network-missed device absent from
// `effectiveList`, so its tracking is overlaid from the prior raw entries and
// the raw cache is left intact (the partial read isn't the full picker list).
function adoptCommittedDeviceList(
    refresh: SnapshotRefreshService,
    effectiveList: HomeyDeviceLike[],
    fetchSource: DeviceFetchSource,
    committedSnapshot: readonly TargetDeviceSnapshot[],
): void {
    const isFullRead = fetchSource === 'raw_manager_devices';
    const trackingList = isFullRead
        ? effectiveList
        : overlayRetainedTrackedDevices({
            effectiveList,
            committedSnapshot,
            priorRawById: refresh.reader.snapshotStore.getTrackedRawDevicesById(),
        });
    refresh.reader.syncTrackedDevices(trackingList);
    if (isFullRead) refresh.reader.snapshotStore.replaceLatestRawDevices(effectiveList);
}

// Rebuild the realtime tracking map and (re)sync native stepped-load command
// adapters from a device list. Side-effecting, so `refreshSnapshot` runs it
// ONLY after the abandon-grace guard has committed the snapshot: a transient
// empty SDK read must not tear down tracking/adapters for devices that are
// still present. The guard already preserves the snapshot on such a read, so
// the matching native adapters must be preserved too — otherwise a default-on
// native stepped-load command (e.g. a Høiax heater) would silently no-op
// (`setObservedNativeSteppedLoadStep` returns false with no adapter) until the
// next good read re-registered it.
async function fetchDevicesForSnapshotRefresh(
    refresh: SnapshotRefreshService,
    isTargetedRefresh: boolean,
): Promise<DeviceFetchResult | null> {
    try {
        return isTargetedRefresh
            ? await refresh.fetchDevicesByKnownIds()
            : await refresh.deviceSdk.fetchDevices();
    } catch (error) {
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

// Snapshot pipeline contract: callers must pass an already-effective device
// list (compatibility metadata + driver-id override pre-applied via
// `refresh.reader.applyDeviceDriverOverride`). Refresh applies the override
// exactly once so it propagates downstream without being re-run by
// `resolveParseDeviceIdentity` inside `parseDevice`.
// Parsing is side-effect-free; the realtime tracking map and native adapters
// are (re)built separately via `syncTrackedDevices`, which `refreshSnapshot`
// runs only after the abandon-grace guard commits the snapshot.
export function computePeriodicStatusMetrics(
    snapshotStore: TransportSnapshotStore,
): ({ devicesTotal: number } & SnapshotRefreshMetrics) | null {
    const snapshot = snapshotStore.getSnapshot();
    if (snapshot.length === 0) return null;
    return {
        devicesTotal: snapshot.length,
        ...summarizeSnapshotRefreshMetrics(snapshot),
    };
}

// Zone tree rides the same refresh cycle (no timer of its own), fired
// DETACHED after the snapshot commit so it can never stall the device
// pipeline or its callers. The WHOLE body is contained: this function runs
// fire-and-forget (`void refreshZoneTreeCache(refresh)`), so nothing here may
// reject — `fetchZoneTree` resolves `null` on its own failure paths, but a
// throwing logger call on one of those paths (or any future edit before the
// commit) would otherwise become an unhandled rejection. A failed/junk/empty
// read commits nothing and the cached tree — like the snapshot on that path —
// stays untouched (abandon-grace).
async function refreshZoneTreeCache(refresh: SnapshotRefreshService): Promise<void> {
    try {
        const generation = refresh.refreshState.beginZoneTreeRefresh();
        const zoneTree = await fetchZoneTree({ logger: refresh.reader.logger });
        if (zoneTree === null) return;
        // Generation guard: detached fetches can resolve out of order — commit
        // only if newer than the last COMMITTED generation. A stale fetch
        // resolving after a newer commit drops, but a superseded-yet-fresher
        // result still lands when the newer fetch failed and committed nothing.
        if (generation <= refresh.refreshState.lastCommittedZoneTreeGeneration()) {
            emitDeviceDebug({
                event: 'zone_tree_fetch_superseded',
                generation,
                lastCommittedGeneration: refresh.refreshState.lastCommittedZoneTreeGeneration(),
            });
            return;
        }
        refresh.refreshState.commitZoneTree(zoneTree, generation);
        // Commit notification (multi-home membership recompute). Guarded
        // separately from the outer catch so a subscriber throw is attributed
        // to the subscriber, not misread as a zone refresh failure.
        try {
            refresh.notifications.notifyZoneTreeCommitted();
        } catch (error) {
            emitDeviceDebug({
                event: 'zone_tree_commit_notify_failed',
                error: normalizeError(error).message,
            });
        }
    } catch (error) {
        // Last-resort containment; the guard itself must never throw, so the
        // logging attempt is swallowed on failure.
        try {
            emitDeviceDebug({
                event: 'zone_tree_refresh_failed',
                error: normalizeError(error).message,
            });
        } catch {
            // Swallowed — see above.
        }
    }
}

// Live-power half of the refresh inputs: the per-device lanes feed parse
// attribution; the sample (null when live power is skipped or the read
// produced no whole-home reading) is the caller's home-power return value.
type RefreshLivePower = {
    byDeviceId: LiveDevicePowerWatts;
    homePowerSample: HomePowerSampleWithIdentity | null;
};

async function resolveLivePowerForRefresh(
    refresh: SnapshotRefreshService,
    includeLivePower: boolean,
    mainMeterSelection: MainMeterSelection,
): Promise<RefreshLivePower> {
    if (!includeLivePower) return { byDeviceId: {}, homePowerSample: null };
    const report = await fetchLivePowerReport(
        refresh.reader.logger,
        refresh.reader.providers,
        mainMeterSelection,
    );
    return {
        byDeviceId: report.state === 'measured' ? report.byDeviceId : {},
        homePowerSample: updateHomePowerFromReport(
            (watts, observedAtMs) => refresh.observationBridge.setGenerationW(watts, observedAtMs),
            report,
        ),
    };
}

export async function refreshSnapshot(
    refresh: SnapshotRefreshService,
    options: SnapshotRefreshOptions,
): Promise<HomePowerSampleWithIdentity | null> {
    const stopSpan = startRuntimeSpan('device_snapshot_refresh');
    const start = Date.now();
    try {
        const previousSnapshot = refresh.reader.snapshotStore.getSnapshot();
        const isTargetedRefresh = options.targetedRefresh === true && previousSnapshot.length > 0;
        const fetchResult = await fetchDevicesForSnapshotRefresh(refresh, isTargetedRefresh);
        if (!fetchResult) return null;
        const { devices: list, fetchSource, failedIds } = fetchResult;
        const { byDeviceId: livePowerByDeviceId, homePowerSample } = await resolveLivePowerForRefresh(
            refresh,
            options.includeLivePower !== false,
            options.mainMeterSelection,
        );
        // The read contract, before anything reads a payload: a device whose read
        // does not conform is ignored — its previous snapshot entry and raw entry
        // stand, none of its values reach a producer, the parse or tracking, and
        // the producers see it as present but unread.
        const read = partitionConformingDeviceReads(
            refresh.reader.snapshotStore,
            refresh.reader.logger,
            list.map((device) => refresh.reader.applyDeviceDriverOverride(device)),
        );
        const effectiveList = observeBatteryStateFromList(
            refresh.observationProducers.battery,
            refresh.observationProducers.solar,
            read,
            fetchSource,
        );
        const presentSnapshot = withIgnoredReadEntries(
            refresh.reader.parseDeviceList(effectiveList, livePowerByDeviceId),
            previousSnapshot,
            read.ignoredIds,
        );
        // Carry the observations the realtime path made since the last refresh
        // over a read that may be older than them.
        mergeFresherCapabilityObservations({
            state: refresh.observationBridge.state.getObservationState(),
            previousSnapshot,
            nextSnapshot: presentSnapshot,
            devices: effectiveList,
            logger: refresh.reader.logger,
        });
        // `fetchSource` resolves whether this committed read is a targeted
        // overlay or a full read — a targeted refresh that fell back to full
        // (every id failed) reports `raw_manager_devices`, so it is treated as
        // authoritative here even though `isTargetedRefresh` was requested.
        const isTargetedOverlay = isTargetedRefresh && fetchSource === 'targeted_by_id';
        const snapshot = resolveCommittedRefreshSnapshot(
            refresh,
            presentSnapshot,
            previousSnapshot,
            isTargetedOverlay ? failedIds : null,
            start,
        );
        // Skip both the snapshot commit AND the raw-device cache update when the
        // abandon-grace guard defers a transient empty read, so getUiPickerDevices()
        // doesn't briefly report zero devices during the blip we're masking.
        const committed = commitRefreshedSnapshot(refresh, {
            snapshot,
            previousSnapshot,
            rawWasEmpty: list.length === 0,
            nowMs: start,
        });
        if (!committed) return homePowerSample;
        adoptCommittedDeviceList(
            refresh,
            withIgnoredReadRawDevices(
                refresh.reader.snapshotStore.getTrackedRawDevicesById(),
                refresh.reader.snapshotStore.getLatestRawDevices(),
                read,
            ),
            fetchSource,
            snapshot,
        );
        // AFTER the commit, unlike the battery/solar producers above: the EV
        // car-link probe resolves charger state by reading the committed
        // snapshot, so running it pre-parse would pair a car transition read in
        // THIS fetch against charger state from the previous one — putting the
        // two sides of a genuine home session in different refreshes and, on the
        // coarse fetch-only cadence, outside the coincidence window entirely.
        // Class `car` devices are dropped by parse, so the probe still reads them
        // from the raw list.
        observeEvCarLinkAndResubscribe(
            refresh.observationProducers.evCarLink,
            (deviceIds) => refresh.deviceSdk.updateTrackedDevices(deviceIds),
            read,
            fetchSource,
            snapshot,
        );
        recordSnapshotRefreshObservations({
            state: refresh.observationBridge.state.getObservationState(),
            snapshot,
            fetchSource,
        });
        emitDeviceDebug({
            event: 'device_snapshot_refresh_processed',
            devicesTotal: snapshot.length,
            targetedRefresh: isTargetedRefresh,
            fetchSource,
            ...(homePowerSample ? { homePowerW: homePowerSample.powerW } : {}),
            livePowerDeviceCount: Object.keys(livePowerByDeviceId).length,
        });
        const metrics = summarizeSnapshotRefreshMetrics(snapshot);
        if (shouldEmitSnapshotRefreshLog(refresh, snapshot.length, metrics)) {
            moduleLogger.info({
                event: 'device_snapshot_refresh_completed',
                durationMs: Date.now() - start,
                devicesTotal: snapshot.length,
                targetedRefresh: isTargetedRefresh,
                ...metrics,
            });
        }
        logEvSnapshotChanges({
            logger: refresh.reader.logger,
            previousSnapshot,
            nextSnapshot: snapshot,
        });
        // DETACHED on purpose (fire-and-forget): the zone tree rides the
        // refresh cycle but must never gate it — even a tail-position await
        // would hold the refreshSnapshot PROMISE (post-write/post-actuation
        // callers, the coalesced refresh queue) for up to the REST timeout
        // when a degraded zones read hangs after a healthy device fetch.
        // The detach is safe: `fetchZoneTree` never throws or rejects, the
        // post-commit notification is contained in `refreshZoneTreeCache`,
        // `zoneTreeCache.set` is a whole-tree last-writer-wins replacement, and
        // refresh cycles are serialized by the coalescing guard, so a dangling
        // fetch racing the next cycle's commit is benign for this dormant,
        // eventually-consistent cache. Still fired only after a successful
        // device fetch + committed snapshot; the grace-deferred empty-read
        // path above skips it for the cycle (a degraded blip already).
        void refreshZoneTreeCache(refresh);
        return homePowerSample;
    } finally {
        stopSpan();
        addPerfDuration('device_refresh_ms', Date.now() - start);
    }
}

/** Owns device snapshot acquisition, parsing, refresh lifecycle and commit. */
export class SnapshotRefreshService {
  // eslint-disable-next-line max-params -- Direct owner collaborators, not an argument bag.
  constructor(
    readonly refreshState: SnapshotRefreshState,
    readonly snapshotCommit: SnapshotCommit,
    readonly observationBridge: ObservationBridge,
    readonly observationProducers: ObservationProducers,
    readonly temperatureRecovery: TemperatureRecoveryService,
    readonly reader: DeviceSnapshotReader,
    readonly deviceSdk: DeviceHomeySdk,
    readonly notifications: TransportNotifications,
  ) {}

  fetchDevicesByKnownIds(): Promise<DeviceFetchResult> {
    const ids = new Set([
      ...this.reader.snapshotStore.getSnapshot().map((device) => device.id),
      ...this.observationProducers.evCarLink.getObservedCarDeviceIds(),
      ...this.temperatureRecovery.getPendingDeviceIds(),
    ]);
    return this.deviceSdk.fetchDevicesByIds([...ids]);
  }

  refresh(options: SnapshotRefreshOptions): Promise<HomePowerSampleWithIdentity | null> {
    return refreshSnapshot(this, options);
  }

}
