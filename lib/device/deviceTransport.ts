/**
 * Device-layer hub: owns observed current device state and the device-specific
 * actuation transport behind one boundary. Reconcile/merge changes are
 * governed by the invariants digest in `lib/device/AGENTS.md` (planned /
 * commanded / observed / effective-planning / pending stay strictly separate;
 * source trust order; an older full fetch must never roll back a fresher
 * realtime or local-write observation) — read it before touching this file.
 *
 * The planner never imports this module directly: plan code reaches
 * `lib/device` only through the producer seams allowlisted by
 * `no-plan-to-device` (`deviceObservation.ts`, `deviceActionProjection.ts`,
 * `deviceResidualKw.ts`), so changes here must surface planner-facing data
 * through those seams, never as new exports for `lib/plan` to import.
 *
 * This class is the Homey-SDK leaf. It keeps SDK wiring (`init`), snapshot
 * orchestration, and the event-emitter/projection bridge; the cohesive,
 * homey-free behaviour (realtime capability handling, binary-settle evidence,
 * device-update reconciliation, device writes) lives in `transport/*` modules
 * that operate over the shared `TransportContext` this class builds. See
 * `notes/state-management/observer-transport-split.md`.
 */
import type Homey from 'homey';
import { EventEmitter } from 'events';
import type {
  AssociatedCarSnapshot,
  BinaryControlObservation,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { projectObservedState } from './observedStateProjection';
import { createCarStateOfChargeAdoption, resolveAssociatedCar } from './transport/carAssociation';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import type { TargetedMissState } from './transport/targetedSnapshotMerge';
import type { LiveDevicePowerWatts } from './managerEnergy';
import { createObservationProducers, type ObservationProducers } from './observationProducers';
import { DeviceMeasuredPowerResolver } from './measuredPowerResolver';
import type { RecentLocalCapabilityWrites } from './transport/managerRealtimeSupport';
import {
  initHomeyHttpClient,
  resolveHomeyInstance,
} from './transport/managerHomeyApi';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import { createDeviceLiveFeed, type DeviceLiveFeed, type LiveFeedHealth } from './liveFeed';
import type {
  ObservationCursor,
  ObservedDeviceStateEvent,
  ObservedDeviceStateRefreshEvent,
  PlanRealtimeUpdateEvent,
} from './transport/managerRealtimeHandlers';
import { normalizeError } from '../utils/errorUtils';
import {
  createObservationState,
  getDebugObservedSources,
  reportFlowSteppedObservation,
  type DeviceDebugObservedSources,
  type DeviceTransportObservationState,
  type FlowSteppedLoadObservation,
} from './transport/managerObservation';
import type { DeviceTransportParseProviders } from './transport/managerParseDevice';
import { applyDeviceDriverOverride } from './transport/managerParseIdentity';
import { syncNativeSteppedLoadCommandAdapters } from './managerNativeSteppedCommand';
import type { DeviceObservation } from './deviceObservation';
import type { SnapshotRefreshOptions, TransportContext } from './transport/transportContext';
import type { HomePowerSampleWithIdentity } from './transport/resolvedHomeMeterDispatch';
import type { PolledHomePowerSample } from './transport/homePowerPoll';
import {
  cloneBinaryControlObservation,
  createEstimateDecisionLogState,
  createPeakPowerLogState,
  type DeviceTransportOptions,
  type DeviceTransportPowerState,
  type ResolvedTransportPowerState,
  type SnapshotRefreshMetrics,
  type TransportObservedStateDispatcher,
} from './transport/transportTypes';
import { reconcileBinarySettleEvidenceWithSnapshot } from './transport/binarySettleEvidence';
import {
    buildBinaryCommandConfirmationSnapshot,
    resolveTemperatureTarget,
} from './transport/semanticControlResolution';
import {
  handleRealtimeCapabilityUpdateWithProbe as runHandleRealtimeCapabilityUpdate,
} from './transport/realtimeCapabilityHandling';
import {
  handleRealtimeDeviceUpdateEvent,
} from './transport/deviceUpdateHandling';
import {
  requestSteppedLoadStep as runRequestSteppedLoadStep,
  setCapability as runSetCapability,
} from './transport/deviceWrites';
import type { DeviceFetchResult } from './transport/managerFetch';
import type { ZoneTree } from './transport/managerZones';
import { ZoneTreeCache } from './transport/zoneTreeCache';
import {
  computePeriodicStatusMetrics,
  fetchLiveGenerationW as runFetchLiveGenerationW,
  type LiveGenerationRead,
  fetchDevicesByKnownIds as runFetchDevicesByKnownIds,
  fetchDevicesForDebug,
  fetchDevicesForSnapshot as runFetchDevicesForSnapshot,
  getSnapshotUiPickerDevices,
  parseSnapshotDevice,
  parseSnapshotDeviceList,
  pollHomePowerWithMeterFanOut as runPollHomePowerWithMeterFanOut,
  refreshSnapshot as runRefreshSnapshot,
  syncTrackedDevices as runSyncTrackedDevices,
} from './transport/snapshotRefresh';
import type { SteppedLoadStepRequestResult } from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';

const moduleLogger = getLogger('device/transport');

export const PLAN_RECONCILE_REALTIME_UPDATE_EVENT = 'plan_reconcile_realtime_update';
export const PLAN_LIVE_STATE_OBSERVED_EVENT = 'plan_live_state_observed';
// Fallback event-name for the full-refresh batch when no dispatcher is injected
// (legacy direct-`DeviceTransport` tests). Mirrors observer's
// `OBSERVED_STATE_REFRESH_EVENT`. Stage 4a of the snapshot decomposition.
const PLAN_LIVE_STATE_OBSERVED_REFRESH_EVENT = 'plan_live_state_observed_refresh';

export type { DeviceDebugObservedSource, DeviceDebugObservedSources } from './transport/managerObservation';
export type {
  DeviceTransportOptions,
  SnapshotRefreshMetrics,
  TransportObservedStateDispatcher,
} from './transport/transportTypes';

export class DeviceTransport extends EventEmitter implements DeviceObservation {
    private sdkReady = false;
    private liveFeed: DeviceLiveFeed | null = null;
    private logger: Logger;
    private homey: Homey.App;
    // Owner-side widened shape: these stored objects are mutated in place across
    // kinds (incl. the EV plug-state the consumer-facing snapshot type omits).
    private latestSnapshot: TransportDeviceSnapshot[] = [];
    private latestSnapshotById: Map<string, TransportDeviceSnapshot> = new Map();
    // Per-device transient-miss state for targeted (by-id) refreshes. A device
    // present in the targeted request set but absent from the read result this
    // cycle advances its {misses,firstMissMs}; a successful read (or any full
    // refresh) resets it. Owned here, mutated by `mergeTargetedRefreshSnapshot`,
    // which drives the read-count + wall-clock retain-vs-drop grace.
    private readonly targetedMissByDeviceId: Map<string, TargetedMissState> = new Map();
    private latestTrackedDevicesById: Map<string, HomeyDeviceLike> = new Map();
    // Reassignable snapshot-refresh scalars threaded to `snapshotRefresh.ts`
    // through a stable holder so the captured accessor closures mutate this object
    // (never the `assembleContext` parameter). `emptySnapshotGrace` tracks a run of
    // transient empty SDK reads while a populated snapshot is held (abandon-grace);
    // `latestRawDevices` is the last full picker list; `lastSnapshotRefreshMetricsKey`
    // dedupes the refresh-completed log.
    private readonly refreshScalars: {
        emptySnapshotGrace: { firstSeenMs: number; reads: number } | null;
        latestRawDevices: HomeyDeviceLike[];
        lastSnapshotRefreshMetricsKey: string | null;
    } = { emptySnapshotGrace: null, latestRawDevices: [], lastSnapshotRefreshMetricsKey: null };
    // Zone-tree cache + fetch-generation guard (see `zoneTreeCache.ts`).
    private readonly zoneTreeCache = new ZoneTreeCache();
    // Zone-tree COMMIT notification seam (multi-home membership recompute).
    // Transport-owned like the observed-state dispatcher, but set-after-
    // construction: wiring subscribes via `setOnZoneTreeCommitted` once the
    // consumer exists and detaches with `undefined` at uninit. Invoked only on
    // a SUCCESSFUL generation-guarded commit (`snapshotRefresh.ts`), contained
    // there so a subscriber throw can never surface on the detached chain.
    private onZoneTreeCommitted?: () => void;
    // Realtime zone-move seam (same shape/lifecycle as `onZoneTreeCommitted`):
    // fires when a realtime device.update commits an entry with a changed
    // `zoneId`; invoked contained in `deviceUpdateHandling.ts`.
    private onDeviceZoneChanged?: () => void;
    private powerState: ResolvedTransportPowerState;
    private measuredPowerResolver: DeviceMeasuredPowerResolver;
    private recentLocalCapabilityWrites: RecentLocalCapabilityWrites = new Map();
    private latestBinarySettleEvidenceByDeviceId: Map<string, BinaryControlObservation> = new Map();
    private observationState: DeviceTransportObservationState = createObservationState();
    private observationSeqByDeviceId: Map<string, number> = new Map();
    private recentRealtimeCapabilityEventLogByKey: Map<string, number> = new Map();
    private readonly automaticHomeMeterState = { preferredDeviceId: null as string | null };
    private providers: DeviceTransportParseProviders = {};
    private getFlowTriggerCard: DeviceTransportOptions['getFlowTriggerCard'] | undefined;
    private onSnapshotMutated: DeviceTransportOptions['onSnapshotMutated'] | undefined;
    private debugStructured: StructuredDebugEmitter | undefined;
    private observedStateDispatcher: TransportObservedStateDispatcher | undefined;
    // Read-only home-battery awareness producer. Holds the detected battery-id set
    // (the authoritative role-membership set the app's managed/controllable
    // resolution consults) and emits `battery_state_observed`; never feeds the
    // hard-cap import path. See `batteryStateProducer.ts`. Constructed in the
    // constructor body (its emit needs the already-assigned logger).
    private readonly observationProducers: ObservationProducers;
    // Read-only PV / solar production awareness producer. Holds the detected solar-id
    // set (the authoritative role-membership set the app's managed/controllable
    // resolution consults) and emits `solar_production_observed`; never feeds the
    // hard-cap import path nor the whole-home generation aggregate. See
    // `solarProductionProducer.ts`.
    // Read-only EV car-to-charger link probe. Correlates class `car` devices
    // (invisible to the rest of PELS) against charger plug edges and emits
    // structured events only — no planning, admission, or actuation consumer.
    // See `evCarLinkProducer.ts`.
    // One shared context handed to the homey-free transport collaborators; built
    // once so the extracted free functions mutate the SAME snapshot / evidence
    // maps this class owns (object identity preserved).
    private readonly ctx: TransportContext;

    private readonly handleRealtimeCapabilityUpdate = (
        deviceId: string,
        capabilityId: string,
        value: unknown,
    ): void => runHandleRealtimeCapabilityUpdate(this.ctx, deviceId, capabilityId, value);

    /** Heartbeat for the EV car-link probe's elapsed-time decisions. */
    tickEvCarLink(nowMs: number): void { this.observationProducers.evCarLink.tick(nowMs); }

    private readonly handleRealtimeDeviceUpdate = (device: HomeyDeviceLike): void => (
        handleRealtimeDeviceUpdateEvent(this.ctx, device)
    );

    /* eslint-disable complexity -- constructor wires the transport dependency bags. */
    constructor(
        homey: Homey.App,
        logger: Logger,
        providers?: DeviceTransportParseProviders,
        powerState?: DeviceTransportPowerState,
        options?: DeviceTransportOptions,
    ) {
        super();
        this.homey = homey;
        this.logger = logger;
        this.debugStructured = options?.debugStructured;
        this.getFlowTriggerCard = options?.getFlowTriggerCard;
        this.onSnapshotMutated = options?.onSnapshotMutated;
        this.observedStateDispatcher = options?.observedStateDispatcher;
        this.observationProducers = createObservationProducers({
            emit: (p) => (this.logger.structuredLog ?? moduleLogger).info(p),
            getSnapshots: () => this.latestSnapshot,
            evCarLinkSnapshotAccess: options?.evCarLinkSnapshotAccess,
            // The probe reports; this decides whether anything is written.
            ...createCarStateOfChargeAdoption({
                getCtx: () => this.ctx,
                dispatch: (id, cap) => this.dispatchObservedStateForDevice(id, cap),
            }),
        });
        if (providers) this.providers = providers;
        this.powerState = {
            expectedPowerKwOverrides: powerState?.expectedPowerKwOverrides ?? {},
            lastKnownPowerKw: powerState?.lastKnownPowerKw ?? {},
            lastEstimateDecisionLogByDevice:
                powerState?.lastEstimateDecisionLogByDevice ?? createEstimateDecisionLogState(),
            lastPeakPowerLogByDevice: powerState?.lastPeakPowerLogByDevice ?? createPeakPowerLogState(),
            onLearnedPeakChanged: powerState?.onLearnedPeakChanged,
        };
        this.measuredPowerResolver = new DeviceMeasuredPowerResolver({
            logger: this.logger,
            lastPositiveMeasuredPowerKw: powerState?.lastPositiveMeasuredPowerKw ?? {},
        });
        this.ctx = this.createContext();
    }
    /* eslint-enable complexity */

    private createContext(): TransportContext {
        return DeviceTransport.assembleContext(this);
    }

    // Static so the getters/closures reference `t` (a parameter) rather than an
    // aliased `this`; `t`'s private members are reachable from a static method of
    // the same class. The getters resolve the leaf-reassigned `latestSnapshot` /
    // `latestSnapshotById` lazily so collaborators always see the current array.
    private static assembleContext(t: DeviceTransport): TransportContext {
        const { refreshScalars } = t;
        return {
            owner: t,
            logger: t.logger,
            debugStructured: t.debugStructured,
            onSnapshotMutated: t.onSnapshotMutated,
            get latestSnapshot() { return t.latestSnapshot; },
            get latestSnapshotById() { return t.latestSnapshotById; },
            latestBinarySettleEvidenceByDeviceId: t.latestBinarySettleEvidenceByDeviceId,
            observationState: t.observationState,
            recentLocalCapabilityWrites: t.recentLocalCapabilityWrites,
            recentRealtimeCapabilityEventLogByKey: t.recentRealtimeCapabilityEventLogByKey,
            automaticHomeMeterState: t.automaticHomeMeterState,
            observationProducers: t.observationProducers,
            getFlowTriggerCard: t.getFlowTriggerCard,
            nextObservationCursor: (deviceId, nowMs) => t.nextObservationCursor(deviceId, nowMs),
            dispatchObservedStateChanged: (event) => t.dispatchObservedStateChanged(event),
            dispatchPlanReconcile: (event) => t.dispatchPlanReconcile(event),
            emitPlanReconcileEvent: (event) => t.emitPlanReconcileEvent(event),
            shouldTrackRealtimeDevice: (deviceId) => t.shouldTrackRealtimeDevice(deviceId),
            applyDeviceDriverOverride: (device) => (
                applyDeviceDriverOverride(device, t.providers.getDeviceDriverIdOverride)
            ),
            parseDevice: (device, now, livePowerWByDeviceId) => t.parseDevice(device, now, livePowerWByDeviceId),
            syncTrackedNativeSteppedLoadAdapters: () => t.syncTrackedNativeSteppedLoadAdapters(),
            setTrackedDevice: (deviceId, device) => { t.latestTrackedDevicesById.set(deviceId, device); },
            deleteTrackedDevice: (deviceId) => { t.latestTrackedDevicesById.delete(deviceId); },
            isSdkReady: () => t.sdkReady,
            dispatchObservedStateForDevice: (deviceId, capabilityId) => (
                t.dispatchObservedStateForDevice(deviceId, capabilityId)
            ),
            refreshSnapshot: (options) => t.refreshSnapshot(options),
            providers: t.providers,
            powerState: t.powerState,
            measuredPowerResolver: t.measuredPowerResolver,
            observedStateDispatcher: t.observedStateDispatcher,
            targetedMissByDeviceId: t.targetedMissByDeviceId,
            getEmptySnapshotGrace: () => refreshScalars.emptySnapshotGrace,
            setEmptySnapshotGrace: (value) => { refreshScalars.emptySnapshotGrace = value; },
            getLastSnapshotRefreshMetricsKey: () => refreshScalars.lastSnapshotRefreshMetricsKey,
            setLastSnapshotRefreshMetricsKey: (value) => { refreshScalars.lastSnapshotRefreshMetricsKey = value; },
            getLatestRawDevices: () => refreshScalars.latestRawDevices,
            setLatestRawDevices: (devices) => { refreshScalars.latestRawDevices = devices; },
            zoneTreeCache: t.zoneTreeCache,
            notifyZoneTreeCommitted: () => { t.onZoneTreeCommitted?.(); },
            notifyDeviceZoneChanged: () => { t.onDeviceZoneChanged?.(); },
            getTrackedDevicesById: () => t.latestTrackedDevicesById,
            fetchDevicesForSnapshot: () => t.fetchDevicesForSnapshot(),
            fetchDevicesByKnownIds: () => t.fetchDevicesByKnownIds(),
            setSnapshot: (snapshot) => t.setSnapshot(snapshot),
            dispatchObservedStateRefresh: (snapshot) => t.dispatchObservedStateRefresh(snapshot),
            updateLiveFeedTrackedDevices: (deviceIds) => { t.liveFeed?.updateTrackedDevices(deviceIds); },
        };
    }

    // Read-only producer seams, single-line like the fetch seams above.
    /** Whether `deviceId` is a currently-detected home battery (incl. offline). */
    isBatteryDevice(id: string): boolean { return this.observationProducers.battery.isBatteryDevice(id); }
    /** Whether ANY home battery is currently detected (incl. offline). */
    hasBatteryDevices(): boolean { return this.observationProducers.battery.hasBatteryDevices(); }
    /** Whether `deviceId` is a currently-detected solar device (incl. offline). */
    isSolarDevice(id: string): boolean { return this.observationProducers.solar.isSolarDevice(id); }
    /**
     * The car associated with this charger right now — the probe's live session,
     * narrowed to the cars the user allowed for it. Resolved per call rather than
     * held on the snapshot; see `transport/carAssociation.ts`.
     */
    getAssociatedCar(id: string): AssociatedCarSnapshot | undefined { return resolveAssociatedCar(this.ctx, id); }

    private nextObservationCursor(deviceId: string, nowMs: number = Date.now()): ObservationCursor {
        const observationSeq = (this.observationSeqByDeviceId.get(deviceId) ?? 0) + 1;
        this.observationSeqByDeviceId.set(deviceId, observationSeq);
        return {
            observationSeq,
            observedAtMs: nowMs,
        };
    }

    private emitPlanReconcileEvent(event: PlanRealtimeUpdateEvent): void {
        const cursor = event.observationSeq === undefined || event.observedAtMs === undefined
            ? this.nextObservationCursor(event.deviceId)
            : {};
        this.dispatchPlanReconcile({
            ...event,
            ...cursor,
        });
    }

    /** Admit trusted Flow step feedback into the transport-owned observation snapshot. */
    reportFlowSteppedLoadObservation(params: FlowSteppedLoadObservation): boolean {
        return reportFlowSteppedObservation(this.ctx, params);
    }

    getSnapshot(): TargetDeviceSnapshot[] { return this.latestSnapshot; }

    getBinaryCommandConfirmationSnapshot() {
        return buildBinaryCommandConfirmationSnapshot(this.latestSnapshot);
    }
    getSnapshotByDeviceId(id: string): TargetDeviceSnapshot | undefined { return this.latestSnapshotById.get(id); }
    getUiPickerDevices(): TargetDeviceSnapshot[] { return getSnapshotUiPickerDevices(this.ctx); }
    // Poll-path home power read; also fans the additional (sub-home) meter
    // readings out to the `onAdditionalMeterReadings` provider (multi-home
    // R7b) — see `pollHomePowerWithMeterFanOut` in `homePowerPoll.ts`.
    // `authorizeFanOut` (from the poll source) gates that fan-out on the poll's
    // generation + source liveness so a stale-generation poll cannot deliver an
    // out-of-order sub-meter sample.
    async pollHomePowerW(
        authorizeFanOut?: () => boolean,
    ): Promise<PolledHomePowerSample | null> {
        return runPollHomePowerWithMeterFanOut(this.ctx, authorizeFanOut);
    }
    /**
     * Gross PV production for the flow source's companion poll
     * (`GenerationPollSource`) — a PURE READ that discriminates a missing
     * generation signal from a failed one, so the caller never publishes an SDK
     * failure as a measurement.
     *
     * Deliberately NOT `pollHomePowerW`: that path also publishes `homePowerW`
     * and fires the sub-home meter fan-out. On a flow home Homey's net is not
     * authoritative — for a split import/export meter it floors at 0 while the
     * home genuinely exports (`test-devices` Run D) — so publishing it would
     * overwrite a correct negative net with a wrong zero, and the fan-out would
     * start delivering sub-home samples no flow-home consumer expects.
     */
    async readGenerationW(): Promise<LiveGenerationRead> {
        return runFetchLiveGenerationW(this.logger);
    }
    setSnapshotForTests(snapshot: TransportDeviceSnapshot[]): void {
        // Mirror the production refresh funnel (`commitRefreshedSnapshot`): commit
        // the snapshot, then dispatch the observed-state refresh so the observer
        // projection is fed exactly as it is in production. Without this, a test
        // that seeds state via `setSnapshotForTests` leaves the projection empty,
        // so any reader routed onto the projection would silently fall back to the
        // snapshot and the projection path would never be exercised by the suite.
        this.setSnapshot(snapshot);
        this.dispatchObservedStateRefresh(snapshot);
    }
    setSnapshot(s: TransportDeviceSnapshot[]): void {
        this.latestSnapshot = s;
        this.syncLatestSnapshotIndex();
        reconcileBinarySettleEvidenceWithSnapshot(this.ctx, s);
    }
    injectDeviceUpdateForTest(device: HomeyDeviceLike): void { this.handleRealtimeDeviceUpdate(device); }
    injectCapabilityUpdateForTest(deviceId: string, capabilityId: string, value: unknown): void {
        this.handleRealtimeCapabilityUpdate(deviceId, capabilityId, value);
    }
    // Returns the OWNER-shaped `TransportDeviceSnapshot[]` (the runtime value the
    // snapshot parse pipeline produces) so test assertions can read the
    // stepped-descriptor + reported-step probe fields the base type omits.
    parseDeviceListForTests(list: HomeyDeviceLike[]): TransportDeviceSnapshot[] {
        const resolveOverride = this.providers.getDeviceDriverIdOverride;
        const effectiveList = list.map((device) => applyDeviceDriverOverride(device, resolveOverride));
        runSyncTrackedDevices(this.ctx, effectiveList);
        return parseSnapshotDeviceList(this.ctx, effectiveList, {}, 'unfiltered');
    }
    async getDevicesForDebug(): Promise<HomeyDeviceLike[]> { return fetchDevicesForDebug(this.ctx); }
    // Thin fetch seams: the snapshot pipeline calls these via `TransportContext`
    // (not the impls directly) so a test spy on the instance method is honored.
    private fetchDevicesForSnapshot(): Promise<DeviceFetchResult> { return runFetchDevicesForSnapshot(this.ctx); }
    private fetchDevicesByKnownIds(): Promise<DeviceFetchResult> { return runFetchDevicesByKnownIds(this.ctx); }
    getDebugObservedSources(deviceId: string): DeviceDebugObservedSources | null {
        return getDebugObservedSources(this.observationState, deviceId);
    }
    getBinarySettleEvidenceByDeviceId(id: string): BinaryControlObservation | undefined {
        const found = this.latestBinarySettleEvidenceByDeviceId.get(id);
        return found ? cloneBinaryControlObservation(found) : undefined; }

    async init(): Promise<void> {
        if (this.sdkReady) return;

        const homeyInstance = resolveHomeyInstance(this.homey);

        if (
            !homeyInstance
            || !homeyInstance.api
            || typeof homeyInstance.api.getOwnerApiToken !== 'function'
            || typeof homeyInstance.api.getLocalUrl !== 'function'
            || !homeyInstance.cloud
            || typeof homeyInstance.cloud.getHomeyId !== 'function'
            || !homeyInstance.platform
            || !homeyInstance.platformVersion
        ) {
            (this.logger.structuredLog ?? moduleLogger).info({
                component: 'devices',
                event: 'device_api_init_skipped',
                reasonCode: 'sdk_api_missing',
                realtimeListenerAttached: false,
            });
            this.logger.debug({ event: 'sdk_api_unavailable_skipping_init' });
            return;
        }

        try {
            await initHomeyHttpClient(this.homey);
        } catch (error) {
            const normalizedError = normalizeError(error);
            (this.logger.structuredLog ?? moduleLogger).error({
                event: 'device_api_http_client_init_failed',
                reasonCode: 'http_client_init_failed',
                realtimeListenerAttached: false,
                err: normalizedError,
            });
            return;
        }

        this.sdkReady = true;
        this.liveFeed = createDeviceLiveFeed({
            homey: this.homey,
            logger: this.logger,
            callbacks: {
                onDeviceUpdate: (device) => this.handleRealtimeDeviceUpdate(device),
                onCapabilityUpdate: (deviceId, capabilityId, value) => (
                    this.handleRealtimeCapabilityUpdate(deviceId, capabilityId, value)
                ),
            },
        });
        await this.liveFeed.start();
        (this.logger.structuredLog ?? moduleLogger).info({
            component: 'devices',
            event: 'device_api_initialized',
        });
    }

    async refreshSnapshot(
        options: SnapshotRefreshOptions = {},
    ): Promise<HomePowerSampleWithIdentity | null> {
        return runRefreshSnapshot(this.ctx, options);
    }

    /** Trust an Automatic meter identity only after the app admits its sample. */
    noteAdmittedAutomaticHomeMeter(deviceId: string | null): void {
        if (deviceId !== null) this.automaticHomeMeterState.preferredDeviceId = deviceId;
    }

    getPeriodicStatusMetrics(): ({ devicesTotal: number } & SnapshotRefreshMetrics) | null {
        return computePeriodicStatusMetrics(this.ctx);
    }

    /**
     * Latest successfully fetched zone tree (`manager/zones/zone`), refreshed
     * co-temporally with the snapshot; `null` until the first successful fetch.
     * A failed fetch retains the previous tree (abandon-grace). Additive/
     * dormant: no runtime consumer yet — multi-home membership will join
     * device `zoneId`s against it.
     */
    getZoneTree(): ZoneTree | null { return this.zoneTreeCache.get(); }

    /**
     * Subscribe/detach the zone-tree commit notification (see the field doc on
     * `onZoneTreeCommitted`). Single-consumer seam: the multi-home membership
     * wiring subscribes after construction and detaches with `undefined` at
     * uninit so a late detached commit cannot recompute a torn-down consumer.
     */
    setOnZoneTreeCommitted(callback: (() => void) | undefined): void { this.onZoneTreeCommitted = callback; }

    /** Realtime zone-move subscription; same single-consumer lifecycle as `setOnZoneTreeCommitted`. */
    setOnDeviceZoneChanged(callback: (() => void) | undefined): void { this.onDeviceZoneChanged = callback; }

    async setCapability(deviceId: string, capabilityId: string, value: unknown): Promise<unknown> {
        return runSetCapability(this.ctx, deviceId, capabilityId, value);
    }

    /**
     * Semantic binary write. Raw capability and native-vs-Flow routing stay
     * inside the transport owner seam and never enter planner/executor intent.
     */
    async requestBinaryControl(
        deviceId: string,
        desired: boolean,
        triggerFlow: (deviceId: string, capabilityId: string, desired: boolean) => Promise<void>,
    ): Promise<void> {
        const snapshot = this.latestSnapshotById.get(deviceId)
            ?? this.latestSnapshot.find((device) => device.id === deviceId);
        const capabilityId = snapshot?.binaryCapabilityId;
        if (!capabilityId) throw new Error(`No binary control binding for device ${deviceId}`);
        if (snapshot.flowBackedCapabilityIds?.includes(capabilityId) === true) {
            await triggerFlow(deviceId, capabilityId, desired);
            return;
        }
        await runSetCapability(this.ctx, deviceId, capabilityId, desired);
    }

    /** Resolve the exact semantic setpoint before executor pending/retry preflight. */
    resolveTemperatureTarget(deviceId: string, desired: number): number {
        return resolveTemperatureTarget(this.latestSnapshot, deviceId, desired);
    }

    /** Semantic primary-temperature write; transport resolves the SDK target. */
    async requestTemperatureTarget(deviceId: string, desired: number): Promise<number> {
        const snapshot = this.latestSnapshotById.get(deviceId)
            ?? this.latestSnapshot.find((device) => device.id === deviceId);
        const target = snapshot?.targets.find((entry) => entry.id.startsWith('target_temperature'));
        if (!target) throw new Error(`No temperature target binding for device ${deviceId}`);
        const requested = await runSetCapability(this.ctx, deviceId, target.id, desired);
        if (typeof requested !== 'number') throw new Error(`Invalid temperature request for device ${deviceId}`);
        return requested;
    }

    isFlowBackedCapability(deviceId: string, capabilityId: string): boolean {
        const snapshot = this.latestSnapshotById.get(deviceId)
            ?? this.latestSnapshot.find((device) => device.id === deviceId);
        return snapshot?.flowBackedCapabilityIds?.includes(capabilityId) === true;
    }

    async requestSteppedLoadStep(params: {
        deviceId: string;
        profile: SteppedLoadProfile;
        desiredStepId: string;
        planningPowerW: number;
        planningCurrentA: number;
        previousStepId?: string;
    }): Promise<SteppedLoadStepRequestResult> {
        return runRequestSteppedLoadStep(this.ctx, params);
    }

    getLiveFeedHealth(): LiveFeedHealth | null { return this.liveFeed?.getHealth() ?? null; }
    private shouldTrackRealtimeDevice(deviceId: string): boolean {
        return this.providers.getManaged ? this.providers.getManaged(deviceId) === true : true;
    }

    public destroy(): void {
        this.observationProducers.destroy();
        void this.liveFeed?.stop();
        this.liveFeed = null;
        this.latestBinarySettleEvidenceByDeviceId.clear();
        this.latestTrackedDevicesById.clear();
        this.removeAllListeners();
    }

    // Single-device parse seam consumed by the realtime device-update collaborator
    // via `TransportContext.parseDevice`. Delegates to the snapshot parse pipeline
    // so the deps assembly lives in one place (`snapshotRefresh.ts`).
    private parseDevice(
        device: HomeyDeviceLike,
        now: number,
        livePowerWByDeviceId: LiveDevicePowerWatts,
    ): TargetDeviceSnapshot | null {
        return parseSnapshotDevice(this.ctx, device, now, livePowerWByDeviceId);
    }

    /**
     * Dispatch the current observed state of a single device through the same
     * funnel + per-device cursor the realtime handlers use. For wiring-layer
     * paths that mutate a snapshot device's observed surface in place outside
     * transport's own handlers (e.g. app-side flow-backed freshness sync) — the
     * caller mutates the snapshot object (shared by reference with
     * `latestSnapshotById`), then calls this so the observer projection records
     * the change instead of lagging until the next full refresh. No-op when the
     * device isn't in the current snapshot.
     */
    dispatchObservedStateForDevice(deviceId: string, capabilityId?: string): void {
        if (!this.latestSnapshotById.has(deviceId)) return;
        this.dispatchObservedStateChanged({
            source: 'realtime_capability',
            deviceId,
            ...this.nextObservationCursor(deviceId),
            ...(capabilityId !== undefined ? { capabilityId } : {}),
        });
    }

    /**
     * Post-translation fan-out of an `observed-state-changed` event.
     *
     * When wiring has injected an `observedStateDispatcher` (production path),
     * observer owns the emitter and transport routes the event through it.
     * When the dispatcher is omitted (legacy direct-`DeviceTransport` tests),
     * transport falls back to emitting through its own EventEmitter using
     * the historical `PLAN_LIVE_STATE_OBSERVED_EVENT` name so existing test
     * subscriptions keep working.
     *
     * Per PR #5 of the observer/transport split, transport never statically
     * imports observer; the dispatcher is just a callback pair passed in at
     * construction time (notes/state-management/observer-transport-split.md).
     */
    private dispatchObservedStateChanged(event: ObservedDeviceStateEvent): void {
        // Attach the decided observed value once, at the single dispatch funnel,
        // rather than at each of the 4 call sites. The observer projection
        // records this merged value; it never re-runs the fresher-wins merge.
        // Stage 4a of the snapshot decomposition.
        const snapshot = this.latestSnapshotById.get(event.deviceId);
        const enriched: ObservedDeviceStateEvent = snapshot
            ? { ...event, observed: projectObservedState(snapshot) }
            : event;
        if (this.observedStateDispatcher) {
            this.observedStateDispatcher.observedStateChanged(enriched);
            return;
        }
        this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, enriched);
    }

    /**
     * Fan-out of the refresh batch. Built from the just-committed snapshot:
     * each device gets a FRESH per-device cursor (so the refresh supersedes any
     * in-flight per-capability delta) and the decided observed value. Mirrors
     * `dispatchObservedStateChanged`'s dispatcher-or-fallback shape. Fired from
     * `commitRefreshedSnapshot` only after `setSnapshot`, so the grace-deferred
     * path (commit returns false before `setSnapshot`) never fires it.
     * Stage 4a of the snapshot decomposition.
     *
     * The committed snapshot is always complete truth for the known device set (a
     * full read, or a targeted overlay with the per-device grace already applied),
     * so `applyRefresh` prunes devices absent from this batch unconditionally.
     */
    private dispatchObservedStateRefresh(snapshot: TargetDeviceSnapshot[]): void {
        // One timestamp for the whole batch: every entry in a single refresh
        // shares the same observedAtMs so the projection's defensive
        // timestamp-fallback ordering can't reorder devices within one commit.
        const nowMs = Date.now();
        const event: ObservedDeviceStateRefreshEvent = {
            entries: snapshot.map((device) => {
                const cursor = this.nextObservationCursor(device.id, nowMs);
                return {
                    observationSeq: cursor.observationSeq,
                    observedAtMs: cursor.observedAtMs,
                    observed: projectObservedState(device),
                };
            }),
        };
        if (this.observedStateDispatcher) {
            this.observedStateDispatcher.observedStateRefresh(event);
            return;
        }
        this.emit(PLAN_LIVE_STATE_OBSERVED_REFRESH_EVENT, event);
    }

    /**
     * Post-translation fan-out of a `plan-reconcile-observed` event.
     * See `dispatchObservedStateChanged` for the dispatcher-vs-fallback
     * contract; same fallback shape for `PLAN_RECONCILE_REALTIME_UPDATE_EVENT`.
     */
    private dispatchPlanReconcile(event: PlanRealtimeUpdateEvent): void {
        if (this.observedStateDispatcher) {
            this.observedStateDispatcher.planReconcile(event);
            return;
        }
        this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, event);
    }

    private syncLatestSnapshotIndex(): void { this.latestSnapshotById
        = new Map(this.latestSnapshot.map((device) => [device.id, device])); }

    private syncTrackedNativeSteppedLoadAdapters(): void {
        syncNativeSteppedLoadCommandAdapters({
            owner: this,
            devices: [...this.latestTrackedDevicesById.values()],
            shouldTrackDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
            logger: this.logger,
        });
    }
}
