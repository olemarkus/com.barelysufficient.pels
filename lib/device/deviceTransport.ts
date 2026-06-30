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
  BinaryControlObservation,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { projectObservedState } from './observedStateProjection';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import type { TargetedMissState } from './transport/targetedSnapshotMerge';
import type { PowerEstimateState } from './devicePowerEstimate';
import type { LiveDevicePowerWatts } from './managerEnergy';
import { BatteryStateProducer } from './batteryStateProducer';
import { SolarProductionProducer } from './solarProductionProducer';
import { DeviceMeasuredPowerResolver } from './measuredPowerResolver';
import {
  clearLocalCapabilityWrite,
  type RecentLocalCapabilityWrites,
} from './transport/managerRealtimeSupport';
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
  type DeviceDebugObservedSources,
  type DeviceTransportObservationState,
} from './transport/managerObservation';
import type {
  DeviceTransportParseProviders,
} from './transport/managerParseDevice';
import { applyDeviceDriverOverride } from './transport/managerParseIdentity';
import { syncNativeSteppedLoadCommandAdapters } from './managerNativeSteppedCommand';
import type { DeviceObservation } from './deviceObservation';
import type { TransportContext } from './transport/transportContext';
import type { BinarySettleState } from '../observer/binarySettle';
import {
  cloneBinaryControlObservation,
  createEmptyBinarySettleState,
  createEstimateDecisionLogState,
  createInertBinarySettleOps,
  createPeakPowerLogState,
  MIN_SIGNIFICANT_POWER_W,
  type BinarySettleDepsForTransport,
  type DeviceTransportBinarySettleOps,
  type DeviceTransportOptions,
  type DeviceTransportPowerState,
  type SnapshotRefreshMetrics,
  type TransportObservedStateDispatcher,
} from './transport/transportTypes';
import {
  reconcileBinarySettleEvidenceWithSnapshot,
} from './transport/binarySettleEvidence';
import {
  handleRealtimeCapabilityUpdate as runHandleRealtimeCapabilityUpdate,
} from './transport/realtimeCapabilityHandling';
import {
  handleRealtimeDeviceUpdateEvent,
} from './transport/deviceUpdateHandling';
import {
  applyDeviceTargets as runApplyDeviceTargets,
  previewDeviceTargets as runPreviewDeviceTargets,
  requestSteppedLoadStep as runRequestSteppedLoadStep,
  setCapability as runSetCapability,
} from './transport/deviceWrites';
import type { DeviceFetchResult } from './transport/managerFetch';
import {
  computePeriodicStatusMetrics,
  fetchDevicesByKnownIds as runFetchDevicesByKnownIds,
  fetchDevicesForDebug,
  fetchDevicesForSnapshot as runFetchDevicesForSnapshot,
  fetchLivePowerReport as runFetchLivePowerReport,
  getSnapshotUiPickerDevices,
  parseSnapshotDevice,
  parseSnapshotDeviceList,
  refreshSnapshot as runRefreshSnapshot,
  syncTrackedDevices as runSyncTrackedDevices,
  updateHomePowerFromReport as runUpdateHomePowerFromReport,
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
export type { BinarySettleState } from '../observer/binarySettle';
export type {
  BinarySettleDepsForTransport,
  DeviceTransportBinarySettleOps,
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
    private powerState: Required<PowerEstimateState>;
    private measuredPowerResolver: DeviceMeasuredPowerResolver;
    private recentLocalCapabilityWrites: RecentLocalCapabilityWrites = new Map();
    private latestBinarySettleEvidenceByDeviceId: Map<string, BinaryControlObservation> = new Map();
    private binarySettleState: BinarySettleState;
    private binarySettleOps: DeviceTransportBinarySettleOps;
    private observationState: DeviceTransportObservationState = createObservationState();
    private observationSeqByDeviceId: Map<string, number> = new Map();
    private recentRealtimeCapabilityEventLogByKey: Map<string, number> = new Map();
    private providers: DeviceTransportParseProviders = {};
    private getFlowTriggerCard: DeviceTransportOptions['getFlowTriggerCard'] | undefined;
    private onSnapshotMutated: DeviceTransportOptions['onSnapshotMutated'] | undefined;
    private debugStructured: StructuredDebugEmitter | undefined;
    private pendingPredicate: DeviceTransportOptions['pendingPredicate'] | undefined;
    private observedStateDispatcher: TransportObservedStateDispatcher | undefined;
    // Read-only home-battery awareness producer. Holds the detected battery-id set
    // (the authoritative role-membership set the app's managed/controllable
    // resolution consults) and emits `battery_state_observed`; never feeds the
    // hard-cap import path. See `batteryStateProducer.ts`. Constructed in the
    // constructor body (its emit needs the already-assigned logger).
    private readonly batteryStateProducer: BatteryStateProducer;
    // Read-only PV / solar production awareness producer. Holds the detected solar-id
    // set (the authoritative role-membership set the app's managed/controllable
    // resolution consults) and emits `solar_production_observed`; never feeds the
    // hard-cap import path nor the whole-home generation aggregate. See
    // `solarProductionProducer.ts`.
    private readonly solarProductionProducer: SolarProductionProducer;
    // One shared context handed to the homey-free transport collaborators; built
    // once so the extracted free functions mutate the SAME snapshot / evidence
    // maps this class owns (object identity preserved).
    private readonly ctx: TransportContext;

    private readonly handleRealtimeCapabilityUpdate = (
        deviceId: string,
        capabilityId: string,
        value: unknown,
    ): void => runHandleRealtimeCapabilityUpdate(this.ctx, deviceId, capabilityId, value);

    private readonly handleRealtimeDeviceUpdate = (device: HomeyDeviceLike): void => (
        handleRealtimeDeviceUpdateEvent(this.ctx, device)
    );

    /* eslint-disable complexity --
     * Constructor wires every option in the bag; complexity is in the
     * fan-out, not the logic. PR #4 added two more ?? branches
     * (binarySettleOps + binarySettleState) on top of the existing
     * options bag; consolidating the bag is left to a follow-up. */
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
        this.pendingPredicate = options?.pendingPredicate;
        this.observedStateDispatcher = options?.observedStateDispatcher;
        this.batteryStateProducer = new BatteryStateProducer(
            (p) => (this.logger.structuredLog ?? moduleLogger).info(p),
        );
        this.solarProductionProducer = new SolarProductionProducer(
            (p) => (this.logger.structuredLog ?? moduleLogger).info(p),
        );
        this.binarySettleOps = options?.binarySettleOps ?? createInertBinarySettleOps();
        this.binarySettleState = options?.binarySettleState ?? createEmptyBinarySettleState();
        if (providers) this.providers = providers;
        this.powerState = {
            expectedPowerKwOverrides: powerState?.expectedPowerKwOverrides ?? {},
            lastKnownPowerKw: powerState?.lastKnownPowerKw ?? {},
            lastEstimateDecisionLogByDevice:
                powerState?.lastEstimateDecisionLogByDevice ?? createEstimateDecisionLogState(),
            lastPeakPowerLogByDevice: powerState?.lastPeakPowerLogByDevice ?? createPeakPowerLogState(),
        };
        this.measuredPowerResolver = new DeviceMeasuredPowerResolver({
            logger: this.logger,
            lastPositiveMeasuredPowerKw: powerState?.lastPositiveMeasuredPowerKw ?? {},
            minSignificantPowerW: MIN_SIGNIFICANT_POWER_W,
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
            binarySettleState: t.binarySettleState,
            binarySettleOps: t.binarySettleOps,
            batteryStateProducer: t.batteryStateProducer,
            solarProductionProducer: t.solarProductionProducer,
            getFlowTriggerCard: t.getFlowTriggerCard,
            nextObservationCursor: (deviceId, nowMs) => t.nextObservationCursor(deviceId, nowMs),
            dispatchObservedStateChanged: (event) => t.dispatchObservedStateChanged(event),
            dispatchPlanReconcile: (event) => t.dispatchPlanReconcile(event),
            emitPlanReconcileEvent: (event) => t.emitPlanReconcileEvent(event),
            consultPendingPredicate: (deviceId, capabilityId) => t.consultPendingPredicate(deviceId, capabilityId),
            shouldTrackRealtimeDevice: (deviceId) => t.shouldTrackRealtimeDevice(deviceId),
            getBinarySettleDeps: () => t.getBinarySettleDeps(),
            applyDeviceDriverOverride: (device) => (
                applyDeviceDriverOverride(device, t.providers.getDeviceDriverIdOverride)
            ),
            parseDevice: (device, now, livePowerWByDeviceId) => t.parseDevice(device, now, livePowerWByDeviceId),
            syncTrackedNativeSteppedLoadAdapters: () => t.syncTrackedNativeSteppedLoadAdapters(),
            setTrackedDevice: (deviceId, device) => { t.latestTrackedDevicesById.set(deviceId, device); },
            deleteTrackedDevice: (deviceId) => { t.latestTrackedDevicesById.delete(deviceId); },
            isSdkReady: () => t.sdkReady,
            updateLocalSnapshot: (deviceId, updates) => t.updateLocalSnapshot(deviceId, updates),
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
            getTrackedDevicesById: () => t.latestTrackedDevicesById,
            fetchDevicesForSnapshot: () => t.fetchDevicesForSnapshot(),
            fetchDevicesByKnownIds: () => t.fetchDevicesByKnownIds(),
            setSnapshot: (snapshot) => t.setSnapshot(snapshot),
            dispatchObservedStateRefresh: (snapshot) => t.dispatchObservedStateRefresh(snapshot),
            updateLiveFeedTrackedDevices: (deviceIds) => { t.liveFeed?.updateTrackedDevices(deviceIds); },
        };
    }

    /** Whether `deviceId` is a currently-detected home battery (incl. offline). */
    isBatteryDevice(deviceId: string): boolean {
        return this.batteryStateProducer.isBatteryDevice(deviceId);
    }

    /** Whether `deviceId` is a currently-detected solar device (incl. offline). */
    isSolarDevice(deviceId: string): boolean {
        return this.solarProductionProducer.isSolarDevice(deviceId);
    }

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

    getSnapshot(): TargetDeviceSnapshot[] { return this.latestSnapshot; }
    getSnapshotByDeviceId(deviceId: string): TargetDeviceSnapshot | undefined {
        return this.latestSnapshotById.get(deviceId);
    }
    getUiPickerDevices(): TargetDeviceSnapshot[] {
        return getSnapshotUiPickerDevices(this.ctx);
    }
    async pollHomePowerW(): Promise<{ powerW: number; generationW?: number } | null> {
        return runUpdateHomePowerFromReport(this.ctx, await runFetchLivePowerReport(this.ctx));
    }
    setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
        // Mirror the production refresh funnel (`commitRefreshedSnapshot`): commit
        // the snapshot, then dispatch the observed-state refresh so the observer
        // projection is fed exactly as it is in production. Without this, a test
        // that seeds state via `setSnapshotForTests` leaves the projection empty,
        // so any reader routed onto the projection would silently fall back to the
        // snapshot and the projection path would never be exercised by the suite.
        this.setSnapshot(snapshot);
        this.dispatchObservedStateRefresh(snapshot);
    }
    setSnapshot(s: TargetDeviceSnapshot[]): void {
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
    getBinarySettleEvidenceByDeviceId(deviceId: string): BinaryControlObservation | undefined {
        const evidence = this.latestBinarySettleEvidenceByDeviceId.get(deviceId);
        return evidence ? cloneBinaryControlObservation(evidence) : undefined;
    }

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
        options: { includeLivePower?: boolean; targetedRefresh?: boolean } = {},
    ): Promise<{ powerW: number; generationW?: number } | null> {
        return runRefreshSnapshot(this.ctx, options);
    }

    // Optimistic binary write-back: a shed (turn-off) is trusted as observed
    // truth immediately so the planner doesn't re-shed before the device echoes.
    // (The former `target` branch was dead — the sole caller only ever passes
    // `{ on }` — and was removed.)
    updateLocalSnapshot(deviceId: string, updates: { on: boolean }): void {
        const snap = this.latestSnapshot.find((d) => d.id === deviceId);
        if (!snap) return;
        snap.binaryControl = { on: updates.on };
        snap.lastLocalWriteMs = Date.now();
    }

    getPeriodicStatusMetrics(): ({ devicesTotal: number } & SnapshotRefreshMetrics) | null {
        return computePeriodicStatusMetrics(this.ctx);
    }

    async setCapability(deviceId: string, capabilityId: string, value: unknown): Promise<unknown> {
        return runSetCapability(this.ctx, deviceId, capabilityId, value);
    }

    async requestSteppedLoadStep(params: {
        deviceId: string;
        profile: SteppedLoadProfile;
        desiredStepId: string;
        planningPowerW: number;
        planningCurrentA: number;
        actuationMode?: 'plan' | 'reconcile';
        previousStepId?: string;
    }): Promise<SteppedLoadStepRequestResult> {
        return runRequestSteppedLoadStep(this.ctx, params);
    }

    async applyDeviceTargets(targets: Record<string, number>, contextInfo = ''): Promise<void> {
        return runApplyDeviceTargets(this.ctx, targets, contextInfo);
    }

    previewDeviceTargets(targets: Record<string, number>, contextInfo = ''): void {
        runPreviewDeviceTargets(this.ctx, targets, contextInfo);
    }

    getLiveFeedHealth(): LiveFeedHealth | null { return this.liveFeed?.getHealth() ?? null; }
    private shouldTrackRealtimeDevice(deviceId: string): boolean {
        return this.providers.getManaged ? this.providers.getManaged(deviceId) === true : true;
    }

    public destroy(): void {
        void this.liveFeed?.stop();
        this.liveFeed = null;
        this.binarySettleOps.clearAll(this.binarySettleState);
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
     * Single suppression-predicate entrypoint consulted by the realtime
     * parse pipeline ("is there an in-flight write that should suppress
     * this observation as an echo?"). Backed by observer's binarySettle
     * store via the injected `pendingPredicate` callback; when no
     * predicate is wired (legacy unit tests) we fall back to the local
     * `binarySettleState` Map so existing behaviour is preserved.
     *
     * Per PR #4 of the observer/transport split, transport never
     * statically imports observer; the predicate is just a function
     * reference passed in at construction time
     * (notes/state-management/observer-transport-split.md).
     */
    private consultPendingPredicate(deviceId: string, capabilityId: string): boolean {
        if (this.pendingPredicate) return this.pendingPredicate(deviceId, capabilityId) === true;
        return this.binarySettleOps.hasWindow(this.binarySettleState, deviceId, capabilityId);
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

    private getBinarySettleDeps(): BinarySettleDepsForTransport {
        const recentLocalCapabilityWrites = this.recentLocalCapabilityWrites;
        return {
            logger: this.logger,
            clearLocalCapabilityWrite: (params: { deviceId: string; capabilityId: string }) => (
                clearLocalCapabilityWrite({
                    recentLocalCapabilityWrites,
                    deviceId: params.deviceId,
                    capabilityId: params.capabilityId,
                })
            ),
            isLiveFeedHealthy: () => this.liveFeed?.isHealthy() === true,
            shouldTrackRealtimeDevice: (deviceId: string) => this.shouldTrackRealtimeDevice(deviceId),
            getSnapshotById: (deviceId: string) => this.latestSnapshotById.get(deviceId),
            emitPlanReconcile: (event) => this.emitPlanReconcileEvent(event),
        }; }
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
