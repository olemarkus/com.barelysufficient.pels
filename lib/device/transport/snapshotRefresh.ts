/**
 * Snapshot-acquisition pipeline for `DeviceTransport`, extracted as homey-free
 * free functions over the shared `TransportContext`. Owns the SDK-free
 * orchestration the leaf used to inline: fetch (full / targeted-by-id), live
 * power read, battery/solar role detection, parse, fresher-wins observation
 * merge, the empty-snapshot + targeted-miss abandon-grace logic, the snapshot
 * commit + refresh-event dispatch, and the post-commit device-list adoption.
 *
 * The leaf keeps only the SDK wiring (`init`, the `homey` field) and the
 * EventEmitter/projection bridge; it threads its mutable snapshot/grace/tracking
 * state in through the `TransportContext` accessors so these functions mutate the
 * SAME maps and snapshot object the class owns (object identity preserved).
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type {
  TargetDeviceSnapshot,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import type { TransportContext } from './transportContext';
import { getDeviceId } from './managerHelpers';
import {
  SNAPSHOT_ABANDON_GRACE_MS,
  SNAPSHOT_ABANDON_GRACE_READS,
  mergeTargetedRefreshSnapshot,
  overlayRetainedTrackedDevices,
} from './targetedSnapshotMerge';
import { addPerfDuration } from '../../utils/perfCounters';
import { estimatePower } from '../devicePowerEstimate';
import { startRuntimeSpan } from '../../utils/runtimeTrace';
import { logEvSnapshotChanges, type DeviceCapabilityMap } from '../managerControl';
import { type LiveDevicePowerWatts } from '../managerEnergy';
import {
  fetchDevicesByIds,
  fetchDevicesWithFallback,
  fetchLivePowerReport as fetchLivePowerReportFromSdk,
  type DeviceFetchResult,
  type DeviceFetchSource,
  type LivePowerReport,
} from './managerFetch';
import { getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import {
  mergeFresherCapabilityObservations,
  recordSnapshotRefreshObservations,
  resolveLatestLocalWriteMs,
} from './managerObservation';
import {
  isDevicePowerCapable,
  parseDevice,
  parseDeviceList,
  type ParseDevicePurpose,
} from './managerParseDevice';
import {
  buildEmptyLivePowerReport,
  summarizeSnapshotRefreshMetrics,
  type SnapshotRefreshMetrics,
} from './transportTypes';
import { reconcileBinarySettleEvidenceAfterSnapshotRefresh } from './binarySettleEvidence';
import { fireSnapshotMutatedForRefresh } from './deviceUpdateHandling';

const moduleLogger = getLogger('device/transport');

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

// Detect observe-only devices (home batteries + solar) from the RAW fetched devices
// BEFORE parse, then pass the list through unchanged. Ordering matters: parse routes
// `getManaged`/`getControllable` (→ the app's observe-only-aware resolve functions)
// which consult these same id sets, so they must be current first. This makes
// role-detected batteries/solar resolve managed + non-controllable, so they ride the
// managed snapshot as observe-only devices; it also emits the read-only
// `battery_state_observed` / `solar_production_observed` events. A FULL read
// (`raw_manager_devices`) re-derives the sets; a targeted by-id read re-reads the
// SAME known ids and must not narrow them.
function observeBatteryStateFromList(
    ctx: TransportContext,
    effectiveList: HomeyDeviceLike[],
    fetchSource: DeviceFetchSource,
): HomeyDeviceLike[] {
    const fullRefresh = fetchSource === 'raw_manager_devices';
    ctx.batteryStateProducer.observe(effectiveList, { fullRefresh });
    ctx.solarProductionProducer.observe(effectiveList, { fullRefresh });
    return effectiveList;
}

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
function shouldDeferEmptySnapshotCommit(
    ctx: TransportContext,
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
        ctx.setEmptySnapshotGrace(null);
        return false;
    }
    const grace = ctx.getEmptySnapshotGrace() ?? { firstSeenMs: nowMs, reads: 0 };
    grace.reads += 1;
    ctx.setEmptySnapshotGrace(grace);
    const elapsedMs = nowMs - grace.firstSeenMs;
    if (elapsedMs >= EMPTY_SNAPSHOT_ABANDON_GRACE_MS
        || grace.reads >= EMPTY_SNAPSHOT_ABANDON_GRACE_READS) {
        (ctx.logger.structuredLog ?? moduleLogger).warn({
            component: 'devices',
            event: 'device_snapshot_empty_grace_exceeded',
            reasonCode: 'empty_snapshot_committed',
            consecutiveEmptyReads: grace.reads,
            graceElapsedMs: elapsedMs,
            previousDevicesTotal: previousSnapshot.length,
        });
        ctx.setEmptySnapshotGrace(null);
        return false;
    }
    (ctx.logger.structuredLog ?? moduleLogger).warn({
        component: 'devices',
        event: 'device_snapshot_empty_deferred',
        reasonCode: 'empty_snapshot_transient',
        consecutiveEmptyReads: grace.reads,
        graceElapsedMs: elapsedMs,
        previousDevicesTotal: previousSnapshot.length,
    });
    return true;
}

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
    ctx: TransportContext,
    presentSnapshot: TransportDeviceSnapshot[],
    previousSnapshot: readonly TransportDeviceSnapshot[],
    failedIds: readonly string[] | null,
    nowMs: number,
): TransportDeviceSnapshot[] {
    if (failedIds === null) {
        ctx.targetedMissByDeviceId.clear();
        return presentSnapshot;
    }
    const { snapshot, graceExceededIds } = mergeTargetedRefreshSnapshot({
        presentSnapshot,
        previousSnapshot,
        failedIds,
        missByDeviceId: ctx.targetedMissByDeviceId,
        nowMs,
    });
    for (const deviceId of graceExceededIds) {
        (ctx.logger.structuredLog ?? moduleLogger).warn({
            component: 'devices',
            event: 'targeted_device_miss_grace_exceeded',
            deviceId,
        });
    }
    return snapshot;
}

/**
 * Commits a refreshed snapshot unless the abandon-grace guard defers it.
 * Returns `true` when committed, `false` when a transient empty read was held
 * back so the caller can skip the post-commit recording/logging.
 */
function commitRefreshedSnapshot(ctx: TransportContext, params: {
    snapshot: TargetDeviceSnapshot[];
    previousSnapshot: readonly TargetDeviceSnapshot[];
    rawWasEmpty: boolean;
    nowMs: number;
}): boolean {
    const { snapshot, previousSnapshot, rawWasEmpty, nowMs } = params;
    if (shouldDeferEmptySnapshotCommit(ctx, snapshot, previousSnapshot, rawWasEmpty, nowMs)) return false;
    ctx.setSnapshot(snapshot);
    // After setSnapshot so latestSnapshotById is current. The grace-deferred
    // path returns above (before setSnapshot), so the abandon-grace invariant
    // — no refresh event on a deferred empty read — holds by construction.
    ctx.dispatchObservedStateRefresh(snapshot);
    ctx.updateLiveFeedTrackedDevices(snapshot.map((d) => d.id));
    fireSnapshotMutatedForRefresh(ctx, snapshot, previousSnapshot);
    return true;
}

function shouldEmitSnapshotRefreshLog(
    ctx: TransportContext,
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
    if (ctx.getLastSnapshotRefreshMetricsKey() === nextKey) return false;
    ctx.setLastSnapshotRefreshMetricsKey(nextKey);
    return true;
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
    ctx: TransportContext,
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
            priorRawById: ctx.getTrackedDevicesById(),
        });
    syncTrackedDevices(ctx, trackingList);
    if (isFullRead) ctx.setLatestRawDevices(effectiveList);
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
export function syncTrackedDevices(ctx: TransportContext, effectiveList: HomeyDeviceLike[]): void {
    // Rebuild in place (clear + repopulate in list order) so the tracking-map
    // reference the leaf reads elsewhere (`destroy`, native-adapter sync) stays
    // stable; the entry set/order matches the prior `new Map(...)` build.
    const tracked = ctx.getTrackedDevicesById();
    tracked.clear();
    for (const device of effectiveList) {
        const deviceId = getDeviceId(device);
        if (deviceId && ctx.shouldTrackRealtimeDevice(deviceId)) tracked.set(deviceId, device);
    }
    ctx.syncTrackedNativeSteppedLoadAdapters();
}

async function fetchDevicesForSnapshotRefresh(
    ctx: TransportContext,
    isTargetedRefresh: boolean,
): Promise<DeviceFetchResult | null> {
    try {
        // Route through the leaf's instance methods (not the impls directly) so a
        // test spy on `DeviceTransport.fetchDevicesForSnapshot` is honored.
        return isTargetedRefresh
            ? await ctx.fetchDevicesByKnownIds()
            : await ctx.fetchDevicesForSnapshot();
    } catch (error) {
        const normalizedError = normalizeError(error);
        (ctx.logger.structuredLog ?? moduleLogger).error({
            event: 'device_snapshot_refresh_failed',
            reasonCode: 'refresh_failed',
            targetedRefresh: isTargetedRefresh,
            err: normalizedError,
        });
        return null;
    }
}

export async function fetchDevicesForSnapshot(ctx: TransportContext): Promise<DeviceFetchResult> {
    const start = Date.now();
    try {
        return await fetchDevicesWithFallback({
            logger: ctx.logger,
        });
    } finally {
        const durationMs = Date.now() - start;
        addPerfDuration('device_fetch_ms', durationMs);
        addPerfDuration('device_fetch_full_ms', durationMs);
    }
}

export async function fetchDevicesByKnownIds(ctx: TransportContext): Promise<DeviceFetchResult> {
    const start = Date.now();
    try {
        const deviceIds = ctx.latestSnapshot.map((d) => d.id);
        return await fetchDevicesByIds({
            deviceIds,
            logger: ctx.logger,
        });
    } finally {
        const durationMs = Date.now() - start;
        addPerfDuration('device_fetch_ms', durationMs);
        addPerfDuration('device_fetch_targeted_ms', durationMs);
    }
}

export async function fetchDevicesForDebug(ctx: TransportContext): Promise<HomeyDeviceLike[]> {
    return (await ctx.fetchDevicesForSnapshot()).devices;
}

export async function fetchLivePowerReport(ctx: TransportContext): Promise<LivePowerReport> {
    return fetchLivePowerReportFromSdk({ logger: ctx.logger, debugStructured: ctx.debugStructured });
}

export function updateHomePowerFromReport(
    ctx: TransportContext,
    report: LivePowerReport,
): { powerW: number; generationW?: number } | null {
    // PR2a of the observer/transport split: observer owns the home-power
    // read. Transport produces the scalar from the Homey SDK energy report
    // and pushes it to observer's holder via the injected dispatcher; it no
    // longer caches the value locally. The return value still feeds the direct
    // `pollHomePowerW()` caller (homey_energy poll source), with generation
    // carried from the same report so later Flow samples cannot inherit it.
    ctx.observedStateDispatcher?.setHomePowerW(report.homePowerW);
    ctx.observedStateDispatcher?.setGenerationW(report.generationW);
    if (report.homePowerW === null) return null;
    return report.generationW === null
        ? { powerW: report.homePowerW }
        : { powerW: report.homePowerW, generationW: report.generationW };
}

function getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
    return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
        ? device.capabilitiesObj as DeviceCapabilityMap
        : {};
}

function buildParseDeviceDeps(ctx: TransportContext) {
    return {
        logger: ctx.logger,
        providers: ctx.providers,
        debugStructured: ctx.debugStructured,
        powerState: ctx.powerState,
        measuredPowerResolver: ctx.measuredPowerResolver,
        getCapabilityObj: (device: HomeyDeviceLike) => getCapabilityObj(device),
        isPowerCapable: (
            device: HomeyDeviceLike,
            capsStatus: { targetCaps: string[]; hasPower: boolean },
            powerEstimate: ReturnType<typeof estimatePower>,
        ) => isDevicePowerCapable({ device, capsStatus, powerEstimate }),
        resolveLatestLocalWriteMs: (deviceId: string) => resolveLatestLocalWriteMs(ctx.observationState, deviceId),
    };
}

// Snapshot pipeline contract: callers must pass an already-effective device
// list (compatibility metadata + driver-id override pre-applied via
// `ctx.applyDeviceDriverOverride`). `refreshSnapshot` and
// `parseDeviceListForTests` are the two entry points; both pre-apply the
// override exactly once so it propagates downstream without being re-run by
// this wrapper or by `resolveParseDeviceIdentity` inside `parseDevice`.
// Parsing is side-effect-free; the realtime tracking map and native adapters
// are (re)built separately via `syncTrackedDevices`, which `refreshSnapshot`
// runs only after the abandon-grace guard commits the snapshot.
export function parseSnapshotDeviceList(
    ctx: TransportContext,
    effectiveList: HomeyDeviceLike[],
    livePowerWByDeviceId: LiveDevicePowerWatts = {},
    purpose: ParseDevicePurpose = 'runtime',
): TransportDeviceSnapshot[] {
    return parseDeviceList({
        list: effectiveList,
        livePowerWByDeviceId,
        previousSnapshotById: ctx.latestSnapshotById,
        deps: buildParseDeviceDeps(ctx),
        purpose,
    });
}

export function parseSnapshotDevice(
    ctx: TransportContext,
    device: HomeyDeviceLike,
    now: number,
    livePowerWByDeviceId: LiveDevicePowerWatts,
): TargetDeviceSnapshot | null {
    return parseDevice({
        device,
        now,
        livePowerWByDeviceId,
        previousSnapshot: ctx.latestSnapshotById.get(getDeviceId(device)),
        deps: buildParseDeviceDeps(ctx),
    });
}

export function getSnapshotUiPickerDevices(ctx: TransportContext): TargetDeviceSnapshot[] {
    const rawDevices = ctx.getLatestRawDevices();
    if (rawDevices.length === 0) return [];
    return parseDeviceList({
        list: rawDevices,
        previousSnapshotById: ctx.latestSnapshotById,
        deps: buildParseDeviceDeps(ctx),
        purpose: 'ui_picker',
    });
}

export function computePeriodicStatusMetrics(
    ctx: TransportContext,
): ({ devicesTotal: number } & SnapshotRefreshMetrics) | null {
    const snapshot = ctx.latestSnapshot;
    if (snapshot.length === 0) return null;
    return {
        devicesTotal: snapshot.length,
        ...summarizeSnapshotRefreshMetrics(snapshot),
    };
}

export async function refreshSnapshot(
    ctx: TransportContext,
    options: { includeLivePower?: boolean; targetedRefresh?: boolean } = {},
): Promise<{ powerW: number; generationW?: number } | null> {
    const stopSpan = startRuntimeSpan('device_snapshot_refresh');
    const start = Date.now();
    try {
        const previousSnapshot = ctx.latestSnapshot;
        const isTargetedRefresh = options.targetedRefresh === true && ctx.latestSnapshot.length > 0;
        const fetchResult = await fetchDevicesForSnapshotRefresh(ctx, isTargetedRefresh);
        if (!fetchResult) return null;
        const { devices: list, fetchSource, failedIds } = fetchResult;
        const shouldReadLivePower = options.includeLivePower !== false;
        const livePowerReport = shouldReadLivePower
            ? await fetchLivePowerReport(ctx)
            : buildEmptyLivePowerReport();
        const homePowerSample = shouldReadLivePower ? updateHomePowerFromReport(ctx, livePowerReport) : null;
        const effectiveList = observeBatteryStateFromList(
            ctx,
            list.map((device) => ctx.applyDeviceDriverOverride(device)),
            fetchSource,
        );
        const presentSnapshot = parseSnapshotDeviceList(ctx, effectiveList, livePowerReport.byDeviceId);
        mergeFresherCapabilityObservations({
            state: ctx.observationState,
            previousSnapshot,
            nextSnapshot: presentSnapshot,
            devices: effectiveList,
            logger: ctx.logger,
            debugStructured: ctx.debugStructured,
        });
        reconcileBinarySettleEvidenceAfterSnapshotRefresh(ctx, presentSnapshot, effectiveList);
        // `fetchSource` resolves whether this committed read is a targeted
        // overlay or a full read — a targeted refresh that fell back to full
        // (every id failed) reports `raw_manager_devices`, so it is treated as
        // authoritative here even though `isTargetedRefresh` was requested.
        const isTargetedOverlay = isTargetedRefresh && fetchSource === 'targeted_by_id';
        const snapshot = resolveCommittedRefreshSnapshot(
            ctx,
            presentSnapshot,
            previousSnapshot,
            isTargetedOverlay ? failedIds : null,
            start,
        );
        // Skip both the snapshot commit AND the raw-device cache update when the
        // abandon-grace guard defers a transient empty read, so getUiPickerDevices()
        // doesn't briefly report zero devices during the blip we're masking.
        const committed = commitRefreshedSnapshot(ctx, {
            snapshot,
            previousSnapshot,
            rawWasEmpty: effectiveList.length === 0,
            nowMs: start,
        });
        if (!committed) return homePowerSample;
        adoptCommittedDeviceList(ctx, effectiveList, fetchSource, snapshot);
        recordSnapshotRefreshObservations({
            state: ctx.observationState,
            snapshot,
            fetchSource,
        });
        (ctx.debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
            event: 'device_snapshot_refresh_processed',
            devicesTotal: snapshot.length,
            targetedRefresh: isTargetedRefresh,
            fetchSource,
            homePowerW: livePowerReport.homePowerW,
            livePowerDeviceCount: livePowerReport.deviceCount,
        });
        if (ctx.logger.structuredLog) {
            const metrics = summarizeSnapshotRefreshMetrics(snapshot);
            if (shouldEmitSnapshotRefreshLog(ctx, snapshot.length, metrics)) {
                ctx.logger.structuredLog.info({
                    event: 'device_snapshot_refresh_completed',
                    durationMs: Date.now() - start,
                    devicesTotal: snapshot.length,
                    targetedRefresh: isTargetedRefresh,
                    ...metrics,
                });
            }
        }
        logEvSnapshotChanges({
            logger: ctx.logger,
            previousSnapshot,
            nextSnapshot: snapshot,
        });
        return homePowerSample;
    } finally {
        stopSpan();
        addPerfDuration('device_refresh_ms', Date.now() - start);
    }
}
