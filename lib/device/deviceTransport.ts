import type { TaskDeviceConstraint } from '../../packages/contracts/src/taskDelivery';
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
 * `no-plan-to-device` (`deviceActionProjection.ts`, `deviceResidualKw.ts`), so
 * changes here must surface planner-facing data
 * through those seams, never as new exports for `lib/plan` to import.
 *
 * The transport owns snapshot orchestration, device writes, and the
 * dispatcher/projection bridge. SDK setup and the realtime socket are owned by
 * `DeviceHomeySdk`; observation dispatch, snapshot commit, and writes have
 * separate owners. Snapshot refresh and realtime ingestion have separate
 * services, each composed from only the collaborators its workflow uses. See
 * `notes/state-management/observer-transport-split.md`.
 */
import { RetainedPowerPersistence } from './retainedPowerPersistence';
import type Homey from 'homey';
import type { SteppedLoadWrite } from '../ports/steppedLoadWrite';
import type { HomeBatteryDevicesRead } from '../ports/homeBatteryDevices';
import type { StoragePowerCommand, StoragePowerWrite, StorageReleaseCommand } from '../ports/storageCommand';
import type { FlowSteppedLoadAdmission } from '../ports/flowSteppedLoadAdmission';
import { admitFlowSteppedLoadReport } from './transport/observationFlowStepped';
import type {
  AssociatedCarSnapshot,
  BinaryControlObservation,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import {
  applyAssociatedCarStateOfCharge,
  clearAssociatedCarStateOfCharge,
  resolveAssociatedCar,
} from './transport/carAssociation';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { createObservationProducers, type ObservationProducers } from './observationProducers';
import { DeviceHomeySdk } from './transport/deviceHomeySdk';
import type { LiveFeedHealth } from './liveFeed';
import { ObservationBridge } from './transport/observationBridge';
import { SnapshotCommit } from './transport/snapshotCommit';
import {
  getDebugObservedSources,
  TemperatureRecoveryService,
  type DeviceDebugObservedSources,
} from './transport/managerObservation';
import type { DeviceTransportParseProviders } from './transport/managerParseDevice';
import {
  createEstimateDecisionLogState,
  createPeakPowerLogState,
  type DeviceTransportOptions,
  type DeviceTransportPowerState,
  type ResolvedTransportPowerState,
  type SnapshotRefreshMetrics,
  type SnapshotRefreshOptions,
} from './transport/transportTypes';
import { BinarySettleEvidenceService } from './transport/binarySettleEvidence';
import {
    buildBinaryCommandConfirmationSnapshot, resolveTemperatureTarget,
} from './transport/semanticControlResolution';
import {
} from './transport/realtimeCapabilityHandling';
import { DeviceWriteService } from './transport/deviceWrites';
import type { ZoneTree } from './transport/managerZones';
import { TransportSnapshotStore } from './transport/transportSnapshotStore';
import { DeviceConfigurationStore } from './deviceConfiguration';
import {
  computePeriodicStatusMetrics,
  fetchLiveGenerationW as runFetchLiveGenerationW,
  type LiveGenerationRead,
  type HomePowerSampleWithIdentity,
  SnapshotRefreshService,
  SnapshotRefreshState,
  pollHomePowerWithMeterFanOut as runPollHomePowerWithMeterFanOut,
} from './transport/snapshotRefresh';
import { DeviceSnapshotReader } from './transport/deviceSnapshotReader';
import { RealtimeIngestService } from './transport/transportServices';
import { TransportNotifications } from './transport/transportNotifications';
import {
    resolveCarAssociationCandidatesRead,
    resolveChargerPhasePresets,
    resolveChargerPhasePresetsRead,
} from './settingsUiDeviceReads';
import type { SteppedLoadStepRequestResult } from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';

export type { DeviceDebugObservedSource, DeviceDebugObservedSources } from './transport/managerObservation';
export type {
  DeviceTransportOptions,
  SnapshotRefreshMetrics,
  TransportObservedStateDispatcher,
} from './transport/transportTypes';

/**
 * `DeviceTransport` as everything outside `lib/device` may hold it: writes, the
 * by-id read, the zone tree, the producer predicates — but not `getSnapshot`.
 * The cached array has one owner (`deviceReads.ts`), and a type that cannot hand
 * it out is what keeps it that way. Declared here rather than beside `AppContext`
 * because it is this class's own narrowing: `lib/device` may not import
 * `lib/app` (`no-domain-to-app-layer`), so a port declared there could never be
 * named by the module that owns it — and routing consumers' device-type import
 * through `lib/app` would launder a peer edge past `setup:boundaries` without
 * decoupling anything.
 */
export type DeviceTransportPort = Omit<DeviceTransport, 'getSnapshot'>;

export class DeviceTransport {
    private readonly deviceSdk: DeviceHomeySdk;
    private readonly logger: Logger;
    // Owner-side widened shape: these stored objects are mutated in place across
    // kinds (incl. the EV plug-state the consumer-facing snapshot type omits).
    private readonly snapshotStore = new TransportSnapshotStore();
    private readonly refreshState = new SnapshotRefreshState();
    readonly deviceConfigurationStore = new DeviceConfigurationStore();
    // Per-device transient-miss state for targeted (by-id) refreshes. A device
    // present in the targeted request set but absent from the read result this
    // cycle advances its {misses,firstMissMs}; a successful read (or any full
    // refresh) resets it. Owned here, mutated by `mergeTargetedRefreshSnapshot`,
    // which drives the read-count + wall-clock retain-vs-drop grace.
    private powerState: ResolvedTransportPowerState;
    private readonly retainedPower: RetainedPowerPersistence;
    private readonly observationBridge: ObservationBridge;
    private readonly binaryEvidence: BinarySettleEvidenceService;
    private readonly snapshotCommit: SnapshotCommit;
    // Pre-wiring boot placeholder only: `initializeDeviceApi` wiring always
    // replaces it. `unavailable` is the honest pre-wiring answer — never a
    // fabricated selection.
    private providers: DeviceTransportParseProviders = {
        getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
    };
    private readonly getFlowTriggerCard: DeviceTransportOptions['getFlowTriggerCard'];
    // Read-only home-battery awareness producer. Holds the detected battery-id set
    // (the authoritative role-membership set the app's managed/controllable
    // resolution consults) and emits `battery_state_observed`; never feeds the
    // hard-cap import path. A battery is commanded only through the actuator's
    // storage intents (`requestStoragePower` / `releaseStorageControl` below),
    // never by this producer. See `batteryStateProducer.ts`. Constructed in the
    // constructor body (its emit needs the already-assigned logger).
    private readonly observationProducers: ObservationProducers;
    private readonly writeService: DeviceWriteService;
    // Read-only PV / solar production awareness producer. Holds the detected solar-id
    // set (the authoritative role-membership set the app's managed/controllable
    // resolution consults) and emits `solar_production_observed`; never feeds the
    // hard-cap import path nor the whole-home generation aggregate. See
    // `solarProductionProducer.ts`.
    // Read-only EV car-to-charger link probe. Correlates class `car` devices
    // (invisible to the rest of PELS) against charger plug edges and emits
    // structured events only — no planning, admission, or actuation consumer.
    // See `evCarLinkProducer.ts`.
    private readonly notifications: TransportNotifications;
    private readonly reader: DeviceSnapshotReader;
    private readonly refreshService: SnapshotRefreshService;
    private readonly realtimeIngest: RealtimeIngestService;

    private readonly handleRealtimeCapabilityUpdate = (
        deviceId: string, capabilityId: string, value: unknown,
    ): void => {
        this.realtimeIngest.handleCapabilityUpdate(deviceId, capabilityId, value);
    };

    /** Heartbeat for the EV car-link probe's elapsed-time decisions. */
    tickEvCarLink(nowMs: number): void { this.observationProducers.evCarLink.tick(nowMs); }

    private readonly handleRealtimeDeviceUpdate = (device: HomeyDeviceLike): void => {
        this.realtimeIngest.handleDeviceUpdate(device);
    };

    constructor(
        homey: Homey.App,
        logger: Logger,
        providers: DeviceTransportParseProviders | undefined,
        powerState: DeviceTransportPowerState | undefined,
        options: DeviceTransportOptions,
    ) {
        this.logger = logger;
        this.getFlowTriggerCard = options.getFlowTriggerCard;
        if (providers) this.providers = providers;
        this.notifications = new TransportNotifications(options.onSnapshotMutated);
        this.deviceSdk = new DeviceHomeySdk(
            homey,
            this.logger,
            this.handleRealtimeDeviceUpdate,
            this.handleRealtimeCapabilityUpdate,
        );
        this.observationProducers = createObservationProducers({
            emit: (p) => this.logger.structuredLog.info(p),
            getSnapshots: () => this.snapshotStore.getSnapshot(),
            evCarLinkSnapshotAccess: options.evCarLinkSnapshotAccess,
            // The probe reports; this decides whether anything is written.
            onAssociatedCarStateOfCharge: (reading) => {
                if (!applyAssociatedCarStateOfCharge(
                    this.providers.getEvCarAssociationCarIds?.(reading.chargerId) ?? [],
                    this.observationProducers.evCarLink.getAssociatedCarForCharger(reading.chargerId),
                    this.snapshotStore,
                    reading,
                )) return;
                this.dispatchObservedStateForDevice(reading.chargerId, 'measure_battery');
            },
            onAssociationEnded: (chargerId) => {
                if (!clearAssociatedCarStateOfCharge(this.snapshotStore, chargerId)) return;
                this.dispatchObservedStateForDevice(chargerId, 'measure_battery');
            },
        });
        this.observationBridge = new ObservationBridge(
            this.snapshotStore,
            options.observedStateDispatcher,
            this.observationProducers.temperature,
        );
        this.writeService = new DeviceWriteService(
            this.snapshotStore,
            this.observationBridge.state,
            this.logger,
            this.observationProducers.temperature,
            (cardId) => this.getFlowTriggerCard?.(cardId),
            (deviceId, capabilityId) => this.dispatchObservedStateForDevice(deviceId, capabilityId),
            (deviceId, nowMs) => this.observationProducers.evCarLink.noteStopCommand(deviceId, nowMs),
        );
        this.powerState = {
            expectedPowerKwOverrides: powerState?.expectedPowerKwOverrides ?? {},
            lastKnownPowerKw: powerState?.lastKnownPowerKw ?? {},
            lastEstimateDecisionLogByDevice:
                powerState?.lastEstimateDecisionLogByDevice ?? createEstimateDecisionLogState(),
            lastPeakPowerLogByDevice: powerState?.lastPeakPowerLogByDevice ?? createPeakPowerLogState(),
            onLearnedPeakChanged: powerState?.onLearnedPeakChanged,
        };
        // The measured-power resolver, built with what it retains restored from the
        // store before the first read (`retainedPowerPersistence.ts`).
        this.retainedPower = new RetainedPowerPersistence(options.retainedPowerStore);
        this.binaryEvidence = new BinarySettleEvidenceService(
            this.snapshotStore,
            this.observationBridge.state,
            this.logger,
            (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
        );
        this.snapshotCommit = new SnapshotCommit(
            this.snapshotStore,
            this.deviceConfigurationStore,
            this.binaryEvidence,
            this.retainedPower,
        );
        const temperatureRecovery = new TemperatureRecoveryService(
            this.observationBridge.state,
            this.snapshotStore,
            (refreshOptions) => this.refreshService.refresh(refreshOptions),
            this.providers,
            (deviceId) => this.observationBridge.nextCursor(deviceId),
            (event) => this.observationBridge.dispatchControlStateChanged(event),
        );
        this.reader = new DeviceSnapshotReader(
            this.snapshotStore,
            this.observationBridge,
            this.providers,
            this.powerState,
            this.retainedPower,
            this.logger,
        );
        this.refreshService = new SnapshotRefreshService(
            this.refreshState,
            this.snapshotCommit,
            this.observationBridge,
            this.observationProducers,
            temperatureRecovery,
            this.reader,
            this.deviceSdk,
            this.notifications,
        );
        this.realtimeIngest = new RealtimeIngestService(
            this.binaryEvidence,
            this.observationBridge,
            this.observationProducers,
            temperatureRecovery,
            this.reader,
            this.notifications,
            this.deviceConfigurationStore,
        );
    }

    // Read-only producer seams, single-line like the fetch seams above.
    /** Whether `deviceId` is a currently-detected home battery (incl. offline). */
    isBatteryDevice(id: string): boolean { return this.observationProducers.battery.isBatteryDevice(id); }
    /** The detected home batteries, `unavailable` until a full refresh has settled them. */
    readHomeBatteryDevices(): HomeBatteryDevicesRead { return this.observationProducers.battery.readBatteryDevices(); }
    /**
     * Told once, when `readHomeBatteryDevices` first turns `resolved`; same
     * single-consumer lifecycle as `setOnZoneTreeCommitted`.
     */
    setOnHomeBatteryDevicesResolved(callback: (() => void) | undefined): void {
        this.observationProducers.battery.setOnBatteryDevicesResolved(callback);
    }
    /** Whether ANY home battery is currently detected (incl. offline). */
    hasBatteryDevices(): boolean { return this.observationProducers.battery.hasBatteryDevices(); }
    /** Whether `deviceId` is a currently-detected solar device (incl. offline). */
    isSolarDevice(id: string): boolean { return this.observationProducers.solar.isSolarDevice(id); }
    /**
     * The car associated with this charger right now — the probe's live session,
     * narrowed to the cars the user allowed for it. Resolved per call rather than
     * held on the snapshot; see `transport/carAssociation.ts`.
     */
    getTaskDeliveryConstraint(deviceId: string): TaskDeviceConstraint {
        return this.observationProducers.evCarLink.getTaskDeliveryConstraint(deviceId);
    }

    getAssociatedCar(id: string): AssociatedCarSnapshot | undefined {
        const eligibleCarIds = this.providers.getEvCarAssociationCarIds?.(id) ?? [];
        const associatedCar = this.observationProducers.evCarLink.getAssociatedCarForCharger(id);
        return resolveAssociatedCar(eligibleCarIds, associatedCar);
    }

    /** Raw Flow feedback is resolved once against the owner-selected control configuration. */
    reportSteppedLoadActualStep(deviceId: string, stepId: string, planningPowerW?: number): FlowSteppedLoadAdmission {
        return admitFlowSteppedLoadReport(
            this.snapshotStore,
            this.deviceConfigurationStore,
            (snapshot, nowMs) => this.notifications.snapshotChanged(snapshot, nowMs),
            (observedDeviceId, capabilityId) => this.dispatchObservedStateForDevice(observedDeviceId, capabilityId),
            deviceId,
            stepId,
            planningPowerW,
        );
    }

    getSnapshot(): TargetDeviceSnapshot[] { return this.snapshotStore.getSnapshot(); }

    /** Actuator preflight: writeability is resolved beside the transport binding. */
    canTurnOnDevice(deviceId: string): boolean {
        return this.writeService.canTurnOnDevice(deviceId);
    }

    /**
     * Whether the LAST committed FULL device read listed at least one raw
     * device. The snapshot starts as `[]`, so an empty list cannot say whether
     * the SDK answered or the boot fetch failed or came back empty
     * (`feedback_homey_sdk_unreliable`; the warmup gate releases on `timeout`
     * with whatever it has, and an empty raw read with no previous snapshot
     * commits at once); this can. It follows every full commit, so an
     * empty-read streak that outlasts the abandon grace and commits `[]`
     * turns it cold again — the device list is no longer known. Targeted
     * by-id reads and the car-link producer's snapshot writes do not move it.
     * The silent-meter escalation refuses to spend its one fail-closed shed
     * pass while this is false (`setup/powerSampleFreshnessEscalation.ts`).
     */
    hasWarmSnapshot(): boolean { return this.refreshState.isWarm(); }

    getBinaryCommandConfirmationSnapshot() {
        return buildBinaryCommandConfirmationSnapshot(this.snapshotStore.getSnapshot());
    }
    /**
     * `TransportDeviceSnapshot`, not the narrower `TargetDeviceSnapshot`: the map
     * holds the transport's own shape, and owner-seam consumers intersect the
     * observed/descriptor PROBES onto what they receive. Declared as the base it
     * would compile anyway — every probe member is optional — and work only
     * because the object happens to be physically wider, which is the failure
     * `deviceDescriptorProjection.ts` was written to stop repeating.
     */
    getSnapshotByDeviceId(id: string): TransportDeviceSnapshot | undefined {
        return this.snapshotStore.getSnapshotByDeviceId(id);
    }
    getUiPickerDevices(): TransportDeviceSnapshot[] { return this.reader.getUiPickerDevices(); }
    /** Reported charger wiring, over the same raw list the picker parses, so unmanaged chargers count. */
    getChargerPhasePresets() { return resolveChargerPhasePresets(this.snapshotStore.getLatestRawDevices()); }
    /** Reported charger wiring after the first trusted full device read. */
    readChargerPhasePresets() {
        return resolveChargerPhasePresetsRead(this.hasWarmSnapshot(), this.snapshotStore.getLatestRawDevices());
    }
    /** Association-capable cars from the last trusted full read; never starts another SDK fetch. */
    readCarAssociationCandidates() {
        return resolveCarAssociationCandidatesRead(
            this.hasWarmSnapshot(),
            this.snapshotStore.getLatestRawDevices(),
            this.observationProducers.evCarLink,
        );
    }
    // Poll-path home power read; also fans the additional (sub-home) meter
    // readings out to the `onAdditionalMeterReadings` provider (multi-home
    // R7b) — see `pollHomePowerWithMeterFanOut` in `homePowerPoll.ts`.
    // `authorizeFanOut` (from the poll source) gates that fan-out on the poll's
    // generation + source liveness so a stale-generation poll cannot deliver an
    // out-of-order sub-meter sample.
    async pollHomePowerW(
        authorizeFanOut?: () => boolean,
    ): Promise<HomePowerSampleWithIdentity | null> {
        return runPollHomePowerWithMeterFanOut(
            this.logger,
            this.providers,
            (watts, observedAtMs) => this.observationBridge.setGenerationW(watts, observedAtMs),
            this.providers.getHomeyEnergyMeterSelection(),
            authorizeFanOut,
        );
    }
    /**
     * Gross PV production for the flow source's companion poll
     * (`GenerationPollSource`) — a PURE READ that discriminates a missing
     * generation signal from a failed one, so the caller never publishes an SDK
     * failure as a measurement.
     *
     * Deliberately NOT `pollHomePowerW`: that path also produces the whole-home
     * net sample and fires the sub-home meter fan-out. On a flow home Homey's
     * net is not authoritative — for a split import/export meter it floors at 0
     * while the home genuinely exports (`test-devices` Run D) — so recording it
     * would overwrite a correct negative net with a wrong zero, and the fan-out
     * would start delivering sub-home samples no flow-home consumer expects.
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
        this.observationBridge.dispatchStateRefresh(snapshot);
    }
    setSnapshot(s: TransportDeviceSnapshot[]): void {
        this.snapshotCommit.commit(s);
    }
    injectDeviceUpdateForTest(device: HomeyDeviceLike): void { this.handleRealtimeDeviceUpdate(device); }
    injectCapabilityUpdateForTest(deviceId: string, capabilityId: string, value: unknown): void {
        this.handleRealtimeCapabilityUpdate(deviceId, capabilityId, value);
    }
    // Returns the OWNER-shaped `TransportDeviceSnapshot[]` (the runtime value the
    // snapshot parse pipeline produces) so test assertions can read the
    // stepped-descriptor + reported-step probe fields the base type omits.
    parseDeviceListForTests(list: HomeyDeviceLike[]): TransportDeviceSnapshot[] {
        return this.reader.parseConformingDeviceListForTests(
            list.map((device) => this.reader.applyDeviceDriverOverride(device)),
        );
    }
    async getDevicesForDebug(): Promise<HomeyDeviceLike[]> {
        return (await this.deviceSdk.fetchDevices()).devices;
    }
    getDebugObservedSources(deviceId: string): DeviceDebugObservedSources | null {
        return getDebugObservedSources(this.observationBridge.state.getObservationState(), deviceId);
    }
    getBinarySettleEvidenceByDeviceId(id: string): BinaryControlObservation | undefined {
        return this.observationBridge.state.getBinarySettleEvidence(id); }

    async init(): Promise<void> { await this.deviceSdk.initialize(); }

    async refreshSnapshot(
        options: SnapshotRefreshOptions,
    ): Promise<HomePowerSampleWithIdentity | null> {
        return this.refreshService.refresh(options);
    }

    getPeriodicStatusMetrics(): ({ devicesTotal: number } & SnapshotRefreshMetrics) | null {
        return computePeriodicStatusMetrics(this.snapshotStore);
    }

    /**
     * Latest successfully fetched zone tree (`manager/zones/zone`), refreshed
     * co-temporally with the snapshot; `null` until the first successful fetch.
     * A failed fetch retains the previous tree (abandon-grace). Additive/
     * dormant: no runtime consumer yet — multi-home membership will join
     * device `zoneId`s against it.
     */
    getZoneTree(): ZoneTree | null { return this.refreshState.getZoneTree(); }

    /**
     * Subscribe/detach the zone-tree commit notification (see the field doc on
     * `onZoneTreeCommitted`). Single-consumer seam: the multi-home membership
     * wiring subscribes after construction and detaches with `undefined` at
     * uninit so a late detached commit cannot recompute a torn-down consumer.
     */
    setOnZoneTreeCommitted(callback: (() => void) | undefined): void {
        this.notifications.setZoneTreeCommitted(callback);
    }

    /** Realtime zone-move subscription; same single-consumer lifecycle as `setOnZoneTreeCommitted`. */
    setOnDeviceZoneChanged(callback: (() => void) | undefined): void {
        this.notifications.setDeviceZoneChanged(callback);
    }

    async setCapability(deviceId: string, capabilityId: string, value: unknown): Promise<unknown> {
        return this.writeService.setCapability(deviceId, capabilityId, value);
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
        // `latestSnapshotById` is authoritative for a by-id read: every writer
        // updates it in the same call that touches `latestSnapshot` (refresh
        // rebuilds it from the array, an unparseable device.update splices and
        // deletes, the capability-drop path does both). The `?? find` that used to
        // sit here was a hedge against a divergence that cannot happen, and a
        // hedging consumer is a symptom — root `AGENTS.md`.
        const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
        const capabilityId = snapshot?.binaryCapabilityId;
        if (!capabilityId) throw new Error(`No binary control binding for device ${deviceId}`);
        // The switch PELS asked for, whatever reaches the SDK (an Easee under
        // built-in control is paused with 0 A): a car-link stop that follows a
        // PELS stop is PELS's, not the car's.
        if (!desired) this.observationProducers.evCarLink.noteStopCommand(deviceId, Date.now());
        if (snapshot.flowBackedCapabilityIds?.includes(capabilityId) === true) {
            await triggerFlow(deviceId, capabilityId, desired);
            return;
        }
        await this.writeService.setCapability(deviceId, capabilityId, desired);
    }

    /** Resolve the exact semantic setpoint before executor pending/retry preflight. */
    resolveTemperatureTarget(deviceId: string, desired: number): number {
        return resolveTemperatureTarget(this.snapshotStore.getSnapshot(), deviceId, desired);
    }

    /** Semantic primary-temperature write; transport resolves the SDK target. */
    async requestTemperatureTarget(deviceId: string, desired: number): Promise<number> {
        const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
        const target = snapshot?.targets.find((entry) => entry.id.startsWith('target_temperature'));
        if (!target) throw new Error(`No temperature target binding for device ${deviceId}`);
        const requested = await this.writeService.setCapability(deviceId, target.id, desired);
        if (typeof requested !== 'number') throw new Error(`Invalid temperature request for device ${deviceId}`);
        return requested;
    }

    isFlowBackedCapability(deviceId: string, capabilityId: string): boolean {
        const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
        return snapshot?.flowBackedCapabilityIds?.includes(capabilityId) === true;
    }

    async requestSteppedLoadStep(
        request: SteppedLoadWrite,
    ): Promise<SteppedLoadStepRequestResult> {
        return this.writeService.requestSteppedLoadStep(request);
    }

    /** A home battery's signed setpoint; the claim and the range stay this owner's binding. */
    async requestStoragePower(command: StoragePowerCommand): Promise<StoragePowerWrite> {
        return this.writeService.requestStoragePower(command);
    }

    /** Hand a home battery back to the claim value recorded before PELS claimed it. */
    async releaseStorageControl(command: StorageReleaseCommand): Promise<void> {
        return this.writeService.releaseStorageControl(command);
    }

    getLiveFeedHealth(): LiveFeedHealth | null { return this.deviceSdk.getHealth(); }
    private shouldTrackRealtimeDevice(deviceId: string): boolean {
        return this.reader.shouldTrackRealtimeDevice(deviceId);
    }

    public destroy(): void {
        this.observationProducers.destroy();
        this.deviceSdk.stop();
        this.observationBridge.state.clear();
        this.snapshotStore.clearTrackedRawDevices();
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
        this.observationBridge.dispatchStateForDevice(deviceId, capabilityId);
    }

}
