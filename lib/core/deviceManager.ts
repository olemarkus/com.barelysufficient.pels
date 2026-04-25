/* eslint-disable max-lines -- Device manager coordinates SDK setup, snapshots, realtime updates, and command writes. */
import Homey from 'homey';
import { EventEmitter } from 'events';
import { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import { getDeviceId } from './deviceManagerHelpers';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { estimatePower, type PowerEstimateState } from './powerEstimate';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import {
    resolveEvCurrentOn,
    logEvCapabilityAccepted,
    logEvCapabilityRequest,
    logEvSnapshotChanges,
    type DeviceCapabilityMap,
} from './deviceManagerControl';
import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import { type LiveDevicePowerWatts } from './deviceManagerEnergy';
import { DeviceMeasuredPowerResolver } from './deviceMeasuredPowerResolver';
import {
    fetchDevicesByIds,
    fetchDevicesWithFallback,
    fetchLivePowerReport,
    type LivePowerReport,
} from './deviceManagerFetch';
import { isRealtimeControlCapability } from './deviceManagerRuntime';
import {
    clearLocalCapabilityWrite,
    formatBinaryState,
    formatTargetValue,
    getRecentLocalCapabilityWrite,
    recordLocalCapabilityWrite,
    type RecentLocalCapabilityWrites,
} from './deviceManagerRealtimeSupport';
import {
    hasRestClient,
    initHomeyHttpClient,
    resolveHomeyInstance,
    setRawCapabilityValue,
} from './deviceManagerHomeyApi';
import type { StructuredDebugEmitter } from '../logging/logger';
import { createDeviceLiveFeed, type DeviceLiveFeed, type LiveFeedHealth } from './deviceLiveFeed';
import {
    didMeasurePowerBecomeSignificantlyPositive,
    handleRealtimeDeviceUpdate,
    type ObservedDeviceStateEvent,
    type PlanRealtimeUpdateEvent,
} from './deviceManagerRealtimeHandlers';
import type { DeviceFetchSource } from './deviceManagerFetch';
import { normalizeError } from '../utils/errorUtils';
import { shouldEmitWindowed } from '../logging/logDedupe';
import {
    clearAllPendingBinarySettleWindows,
    clearPendingBinarySettleWindow,
    createBinarySettleState,
    hasPendingBinarySettleWindow,
    notePendingBinarySettleObservation,
    startPendingBinarySettleWindow,
    type DeviceManagerBinarySettleState,
} from './deviceManagerBinarySettle';
import {
    createObservationState,
    getDebugObservedSources,
    mergeFresherCapabilityObservations,
    recordCapabilityObservation,
    recordDeviceUpdateObservation,
    recordLocalWriteObservation,
    recordSnapshotCapabilityObservations,
    recordSnapshotRefreshObservations,
    resolveLatestLocalWriteMs,
    type DeviceDebugObservedSources,
    type DeviceManagerObservationState,
} from './deviceManagerObservation';
import {
    applyDeviceDriverOverride,
    isDevicePowerCapable,
    parseDevice,
    parseDeviceList,
    type DeviceManagerParseProviders,
} from './deviceManagerParseDevice';
import {
    buildNativeEvObservationDevice,
    normalizeNativeEvCapabilityUpdate,
} from './nativeEvWiring';
import {
    observeNativeSteppedLoadCapabilityUpdate,
    observeNativeSteppedLoadCommandAdapter,
    resolveObservedNativeSteppedLoadReportedStepId,
    syncNativeSteppedLoadCommandAdapters,
} from './deviceManagerNativeSteppedCommand';
import { applyFreshnessOnlyCapabilityUpdate } from './deviceManagerFreshness';
import {
    isNativeSteppedLoadControlEnabled,
    resolveNativeSteppedLoadCapabilityId,
    resolveNativeSteppedLoadReportedStepId,
} from './nativeSteppedLoadWiring';
import { PELS_MEASURE_STEP_CAPABILITY_ID } from './steppedLoadSyntheticCapabilities';

const MIN_SIGNIFICANT_POWER_W = 5;
const REALTIME_CAPABILITY_EVENT_WINDOW_MS = 2 * 1000;
export const PLAN_RECONCILE_REALTIME_UPDATE_EVENT = 'plan_reconcile_realtime_update';
export const PLAN_LIVE_STATE_OBSERVED_EVENT = 'plan_live_state_observed';
export type { DeviceDebugObservedSource, DeviceDebugObservedSources } from './deviceManagerObservation';

const createEstimateDecisionLogState = (): Map<string, { signature: string; emittedAt: number }> => new Map();
const createPeakPowerLogState = (): Map<string, { signature: string; emittedAt: number }> => new Map();
const buildEmptyLivePowerReport = (): LivePowerReport => ({ byDeviceId: {}, homePowerW: null });

type DeviceManagerPowerState = PowerEstimateState & {
    lastPositiveMeasuredPowerKw?: Record<string, { kw: number; ts: number }>;
};

export type SnapshotRefreshMetrics = {
    availableDevices: number;
    temperatureKnownDevices: number;
    temperatureUnknownDevices: number;
    unavailableDevices: number;
};

export class DeviceManager extends EventEmitter {
    private sdkReady = false;
    private liveFeed: DeviceLiveFeed | null = null;
    private logger: Logger;
    private homey: Homey.App;
    private latestSnapshot: TargetDeviceSnapshot[] = [];
    private latestSnapshotById: Map<string, TargetDeviceSnapshot> = new Map();
    private latestHomePowerW: number | null = null;
    private powerState: Required<PowerEstimateState>;
    private measuredPowerResolver: DeviceMeasuredPowerResolver;
    private recentLocalCapabilityWrites: RecentLocalCapabilityWrites = new Map();
    private binarySettleState: DeviceManagerBinarySettleState = createBinarySettleState();
    private observationState: DeviceManagerObservationState = createObservationState();
    private recentRealtimeCapabilityEventLogByKey: Map<string, number> = new Map();
    private lastSnapshotRefreshMetricsKey: string | null = null;
    private providers: DeviceManagerParseProviders = {};
    private readonly handleRealtimeCapabilityUpdate = (
        deviceId: string,
        capabilityId: string,
        value: unknown,
    ): void => {
        if (!this.shouldTrackRealtimeDevice(deviceId)) return;
        const snapshotIndex = this.latestSnapshot.findIndex((entry) => entry.id === deviceId);
        if (snapshotIndex < 0) return;

        const snapshot = this.latestSnapshot[snapshotIndex];
        const normalizedEvents = normalizeNativeEvCapabilityUpdate({
            snapshot,
            capabilityId,
            value,
        });
        for (const normalizedEvent of normalizedEvents) {
            const handledNativeSteppedLoadUpdate = this.handleNativeSteppedLoadCapabilityUpdate({
                snapshotIndex,
                deviceId,
                capabilityId: normalizedEvent.capabilityId,
                value: normalizedEvent.value,
                snapshot,
            });
            if (handledNativeSteppedLoadUpdate) continue;

            const resolvedEvent = this.resolveRealtimeCapabilityEvent(
                snapshot,
                normalizedEvent.capabilityId,
                normalizedEvent.value,
            );
            if (!resolvedEvent) continue;
            const effectiveCapabilityId = resolvedEvent.capabilityId;
            const effectiveValue = resolvedEvent.value;

            const normalizedValue = this.normalizeRealtimeCapabilityEventValue(
                effectiveCapabilityId,
                effectiveValue,
            );
            // Skip echo suppression when a binary settle window is active so the
            // confirmation observation can close it immediately.
            const hasBinarySettleWindow = effectiveCapabilityId === snapshot.controlCapabilityId
                && hasPendingBinarySettleWindow(this.binarySettleState, deviceId, effectiveCapabilityId);
            if (
                !hasBinarySettleWindow
                && this.hasMatchingRecentLocalWrite(deviceId, effectiveCapabilityId, normalizedValue)
            ) {
                continue;
            }

            if (this.isFreshnessOnlyCapability(effectiveCapabilityId)) {
                this.handleFreshnessOnlyCapabilityUpdate(
                    snapshotIndex,
                    deviceId,
                    effectiveCapabilityId,
                    effectiveValue,
                );
                continue;
            }

            this.handleReconcileCapabilityUpdate(
                snapshotIndex,
                deviceId,
                effectiveCapabilityId,
                effectiveValue,
                snapshot,
            );
        }
    };

    private handleNativeSteppedLoadCapabilityUpdate(params: {
        snapshotIndex: number;
        deviceId: string;
        capabilityId: string;
        value: unknown;
        snapshot: TargetDeviceSnapshot;
    }): boolean {
        const {
            snapshotIndex,
            deviceId,
            capabilityId,
            value,
            snapshot,
        } = params;
        if (!isNativeSteppedLoadControlEnabled(snapshot)) return false;
        const profile = snapshot.suggestedSteppedLoadProfile;
        if (profile?.model !== 'stepped_load') return false;

        const nativeCapabilityId = resolveNativeSteppedLoadCapabilityId([capabilityId]);
        const isNativePowerStepUpdate = nativeCapabilityId !== undefined;
        const isNativeBinaryUpdate = capabilityId === snapshot.controlCapabilityId && typeof value === 'boolean';
        if (!isNativePowerStepUpdate && !isNativeBinaryUpdate) return false;

        const normalizedValue = this.normalizeRealtimeCapabilityEventValue(capabilityId, value);
        if (this.hasMatchingRecentLocalWrite(deviceId, capabilityId, normalizedValue)) {
            return isNativePowerStepUpdate;
        }

        observeNativeSteppedLoadCapabilityUpdate({
            owner: this,
            deviceId,
            capabilityId,
            value,
        });

        const fallbackReportedStepId = value === false ? resolveNativeSteppedLoadReportedStepId({
            profile,
            capabilities: [],
            capabilityObj: {
                onoff: { value: false },
            },
        }) : undefined;
        const nextReportedStepId = resolveObservedNativeSteppedLoadReportedStepId({
            owner: this,
            deviceId,
            profile,
        }) ?? fallbackReportedStepId;

        const currentSnapshot = this.latestSnapshot[snapshotIndex];
        const previousReportedStepId = currentSnapshot.reportedStepId;
        if (nextReportedStepId) currentSnapshot.reportedStepId = nextReportedStepId;
        else delete currentSnapshot.reportedStepId;
        currentSnapshot.lastFreshDataMs = Date.now();
        currentSnapshot.lastUpdated = currentSnapshot.lastFreshDataMs;
        if (previousReportedStepId !== nextReportedStepId) {
            this.emitNativeSteppedLoadReportedStepChanged({
                deviceId,
                deviceName: currentSnapshot.name,
                previousReportedStepId,
                nextReportedStepId,
            });
        }
        return isNativePowerStepUpdate;
    }

    private emitNativeSteppedLoadReportedStepChanged(params: {
        deviceId: string;
        deviceName: string;
        previousReportedStepId: string | undefined;
        nextReportedStepId: string | undefined;
    }): void {
        const {
            deviceId,
            deviceName,
            previousReportedStepId,
            nextReportedStepId,
        } = params;
        const change = {
            capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
            previousValue: previousReportedStepId ?? 'unknown',
            nextValue: nextReportedStepId ?? 'unknown',
        };
        this.emitCapabilityEventReceived(
            deviceId,
            PELS_MEASURE_STEP_CAPABILITY_ID,
            nextReportedStepId ?? 'unknown',
        );
        this.logger.structuredLog?.info({
            event: 'realtime_capability_drift',
            deviceId,
            capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
            changes: [change],
        });
        this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, {
            source: 'realtime_capability',
            deviceId,
            capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        } satisfies ObservedDeviceStateEvent);
        this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, {
            deviceId,
            name: deviceName,
            changes: [change],
        } satisfies PlanRealtimeUpdateEvent);
    }

    private handleFreshnessOnlyCapabilityUpdate(
        snapshotIndex: number,
        deviceId: string,
        capabilityId: string,
        value: unknown,
    ): void {
        const snapshot = this.latestSnapshot[snapshotIndex];
        const previousPowerKw = capabilityId === 'measure_power'
            ? snapshot?.measuredPowerKw
            : undefined;
        const result = applyFreshnessOnlyCapabilityUpdate({
            snapshot,
            capabilityId,
            value,
        });
        const reconcileChange = result.reconcileChange;
        if (!result.changed) return;
        recordCapabilityObservation({
            state: this.observationState,
            latestSnapshot: this.latestSnapshot,
            deviceId,
            capabilityId,
            value: result.normalizedValue,
            source: 'realtime_capability',
        });
        this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, {
            source: 'realtime_capability',
            deviceId,
            capabilityId,
            measurePowerBecameSignificantlyPositive: capabilityId === 'measure_power'
                && didMeasurePowerBecomeSignificantlyPositive(
                    previousPowerKw,
                    snapshot?.measuredPowerKw,
                    MIN_SIGNIFICANT_POWER_W,
                ),
        } satisfies ObservedDeviceStateEvent);
        if (reconcileChange && snapshot) {
            this.logger.structuredLog?.info({
                event: 'realtime_capability_drift',
                deviceId,
                capabilityId: reconcileChange.capabilityId,
                changes: [reconcileChange],
            });
            this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, {
                deviceId,
                name: snapshot.name,
                changes: [reconcileChange],
            } satisfies PlanRealtimeUpdateEvent);
        }
    }

    private handleReconcileCapabilityUpdate(
        snapshotIndex: number,
        deviceId: string,
        capabilityId: string,
        value: unknown,
        snapshot: TargetDeviceSnapshot,
    ): void {
        const changes: PlanRealtimeUpdateEvent['changes'] = [];

        if (capabilityId === snapshot.controlCapabilityId && typeof value === 'boolean') {
            const settled = this.applyBinaryCapabilityUpdate(snapshotIndex, deviceId, capabilityId, value, changes);
            if (settled) {
                this.emitCapabilityEventReceived(
                    deviceId,
                    capabilityId,
                    this.normalizeRealtimeCapabilityEventValue(capabilityId, value),
                );
                return;
            }
        }

        for (const target of snapshot.targets) {
            if (
                target.id === capabilityId
                && typeof value === 'number'
                && Number.isFinite(value)
                && target.value !== value
            ) {
                const previousValue = target.value;
                target.value = value;
                changes.push({
                    capabilityId,
                    previousValue: formatTargetValue(previousValue, target.unit),
                    nextValue: formatTargetValue(value, target.unit),
                });
                break;
            }
        }

        if (changes.length === 0) return;

        this.emitCapabilityEventReceived(
            deviceId,
            capabilityId,
            this.normalizeRealtimeCapabilityEventValue(capabilityId, value),
        );
        this.logger.structuredLog?.info({
            event: 'realtime_capability_drift',
            deviceId,
            capabilityId,
            changes,
        });
        recordSnapshotCapabilityObservations({
            state: this.observationState,
            latestSnapshot: this.latestSnapshot,
            deviceId,
            source: 'realtime_capability',
            capabilityIds: [capabilityId],
        });
        this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, {
            source: 'realtime_capability',
            deviceId,
            capabilityId,
        } satisfies ObservedDeviceStateEvent);
        this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, {
            deviceId,
            name: snapshot.name,
            changes,
        } satisfies PlanRealtimeUpdateEvent);
    }

    private isTrackedCapability(snapshot: TargetDeviceSnapshot, capabilityId: string): boolean {
        return this.isReconcileCapability(snapshot, capabilityId) || this.isFreshnessOnlyCapability(capabilityId);
    }

    private resolveRealtimeCapabilityEvent(
        snapshot: TargetDeviceSnapshot,
        capabilityId: string,
        value: unknown,
    ): { capabilityId: string; value: unknown } | null {
        if (this.isTrackedCapability(snapshot, capabilityId)) {
            return { capabilityId, value };
        }
        if (
            snapshot.controlObservationCapabilityId
            && snapshot.controlCapabilityId
            && capabilityId === snapshot.controlObservationCapabilityId
        ) {
            return {
                capabilityId: snapshot.controlCapabilityId,
                value,
            };
        }
        return null;
    }

    private isReconcileCapability(snapshot: TargetDeviceSnapshot, capabilityId: string): boolean {
        return capabilityId === snapshot.controlCapabilityId
            || snapshot.targets.some((t) => t.id === capabilityId);
    }

    private isFreshnessOnlyCapability(capabilityId: string): boolean {
        return capabilityId === 'measure_power'
            || capabilityId === 'measure_temperature'
            || capabilityId === 'evcharger_charging_state';
    }

    private hasMatchingRecentLocalWrite(deviceId: string, capabilityId: string, normalizedValue: unknown): boolean {
        const recentWrite = getRecentLocalCapabilityWrite({
            recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
            deviceId,
            capabilityId,
        });
        if (!recentWrite) return false;
        return Object.is(
            this.normalizeRealtimeCapabilityEventValue(capabilityId, recentWrite.value),
            normalizedValue,
        );
    }

    private normalizeRealtimeCapabilityEventValue(capabilityId: string, value: unknown): unknown {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') {
            if (capabilityId === 'measure_power' || capabilityId.startsWith('meter_power')) return Math.round(value);
            if (capabilityId.includes('temperature')) return Math.round(value * 10) / 10;
            return Math.round(value * 100) / 100;
        }
        if (typeof value === 'string') return value.trim();
        return value;
    }

    private emitCapabilityEventReceived(deviceId: string, capabilityId: string, normalizedValue: unknown): void {
        if (!this.debugStructured) return;
        const key = JSON.stringify([deviceId, capabilityId, normalizedValue]);
        if (!shouldEmitWindowed({
            state: this.recentRealtimeCapabilityEventLogByKey,
            key,
            now: Date.now(),
            windowMs: REALTIME_CAPABILITY_EVENT_WINDOW_MS,
        })) {
            return;
        }
        this.debugStructured({
            event: 'device_capability_event_received',
            source: 'web_api_subscription',
            deviceId,
            capabilityId,
            value: normalizedValue,
        });
    }

    /** Returns true if the change was handled by the binary settle window. */
    private applyBinaryCapabilityUpdate(
        snapshotIndex: number,
        deviceId: string,
        capabilityId: string,
        value: boolean,
        changes: NonNullable<PlanRealtimeUpdateEvent['changes']>,
    ): boolean {
        // Check the settle window before the equality check so a confirmation
        // observation (value === currentOn) can still settle it.
        const settleOutcome = notePendingBinarySettleObservation({
            state: this.binarySettleState,
            deps: this.getBinarySettleDeps(),
            deviceId,
            capabilityId,
            value,
            source: 'realtime_capability',
        });
        if (settleOutcome !== 'none') {
            // Update snapshot to reflect the actual device state in both cases.
            if (capabilityId === 'evcharger_charging') {
                this.latestSnapshot[snapshotIndex].evCharging = value;
                this.latestSnapshot[snapshotIndex].currentOn = resolveEvCurrentOn({
                    evChargingState: this.latestSnapshot[snapshotIndex].evChargingState,
                    evchargerCharging: value,
                });
            } else {
                this.latestSnapshot[snapshotIndex].currentOn = value;
            }
            // Record the observation so freshness tracking advances even for settle events.
            recordSnapshotCapabilityObservations({
                state: this.observationState,
                latestSnapshot: this.latestSnapshot,
                deviceId,
                source: 'realtime_capability',
                capabilityIds: [capabilityId],
            });
            this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, {
                source: 'realtime_capability',
                deviceId,
                capabilityId,
            } satisfies ObservedDeviceStateEvent);
            return true; // reconcile already emitted by settle window on drift; none needed on settle
        }

        const snapshot = this.latestSnapshot[snapshotIndex];
        const previousCurrentOn = snapshot.currentOn;
        if (capabilityId === 'evcharger_charging') {
            this.latestSnapshot[snapshotIndex].evCharging = value;
            this.latestSnapshot[snapshotIndex].currentOn = resolveEvCurrentOn({
                evChargingState: snapshot.evChargingState,
                evchargerCharging: value,
            });
        } else {
            this.latestSnapshot[snapshotIndex].currentOn = value;
        }
        if (snapshot.currentOn === previousCurrentOn) return false;
        changes.push({
            capabilityId,
            previousValue: formatBinaryState(previousCurrentOn),
            nextValue: formatBinaryState(snapshot.currentOn),
        });
        return false;
    }

    private readonly handleRealtimeDeviceUpdate = (device: HomeyDeviceLike): void => {
        const deviceId = getDeviceId(device);
        const effectiveDevice = this.applyDeviceDriverOverride(device);
        if (deviceId && this.shouldTrackRealtimeDevice(deviceId)) {
            observeNativeSteppedLoadCommandAdapter({
                owner: this,
                deviceId,
                device: effectiveDevice,
                clearWhenUnavailable: true,
            });
        }
        const previousSnapshot = this.latestSnapshotById.get(deviceId);
        const observedDevice = buildNativeEvObservationDevice({
            device: effectiveDevice,
            previousSnapshot,
        });
        const result = handleRealtimeDeviceUpdate({
            device: observedDevice,
            latestSnapshot: this.latestSnapshot,
            recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
            shouldTrackRealtimeDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
            parseDevice: (nextDevice, nowTs) => this.parseDevice(nextDevice, nowTs, {}),
            minSignificantPowerW: MIN_SIGNIFICANT_POWER_W,
            recordObservedCapabilities: (nextDeviceId, capabilityIds) => {
                recordSnapshotCapabilityObservations({
                    state: this.observationState,
                    latestSnapshot: this.latestSnapshot,
                    deviceId: nextDeviceId,
                    source: 'device_update',
                    capabilityIds,
                });
            },
            notePendingBinarySettleObservation: (nextDeviceId, capabilityId, value, source) => (
                notePendingBinarySettleObservation({
                    state: this.binarySettleState,
                    deps: this.getBinarySettleDeps(),
                    deviceId: nextDeviceId,
                    capabilityId,
                    value,
                    source,
                })
            ),
            hasPendingBinarySettleWindow: (nextDeviceId, capabilityId) => (
                hasPendingBinarySettleWindow(this.binarySettleState, nextDeviceId, capabilityId)
            ),
            logDebug: (message) => this.logger.debug(message),
            emitPlanReconcile: (event) => this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, event),
            emitObservedState: (event: ObservedDeviceStateEvent) => this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, event),
        });
        if (deviceId && result.currentSnapshot !== undefined) {
            if (result.currentSnapshot) this.latestSnapshotById.set(deviceId, result.currentSnapshot);
            else this.latestSnapshotById.delete(deviceId);
        }
        if (deviceId && result.hadChanges) {
            recordDeviceUpdateObservation({
                state: this.observationState,
                latestSnapshot: this.latestSnapshot,
                deviceId,
                result,
            });
        }
    };

    private debugStructured: StructuredDebugEmitter | undefined;

    constructor(
        homey: Homey.App,
        logger: Logger,
        providers?: DeviceManagerParseProviders,
        powerState?: DeviceManagerPowerState,
        options?: { debugStructured?: StructuredDebugEmitter },
    ) {
        super();
        this.homey = homey;
        this.logger = logger;
        this.debugStructured = options?.debugStructured;
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
    }

    getSnapshot(): TargetDeviceSnapshot[] { return this.latestSnapshot; }
    getHomePowerW(): number | null { return this.latestHomePowerW; }
    async pollHomePowerW(): Promise<number | null> {
        return this.updateHomePowerFromReport(await this.fetchLivePowerReport());
    }
    setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void { this.setSnapshot(snapshot); }
    setSnapshot(s: TargetDeviceSnapshot[]): void { this.latestSnapshot = s; this.syncLatestSnapshotIndex(); }
    injectDeviceUpdateForTest(device: HomeyDeviceLike): void { this.handleRealtimeDeviceUpdate(device); }
    injectCapabilityUpdateForTest(deviceId: string, capabilityId: string, value: unknown): void {
        this.handleRealtimeCapabilityUpdate(deviceId, capabilityId, value);
    }
    parseDeviceListForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] { return this.parseDeviceList(list); }
    async getDevicesForDebug(): Promise<HomeyDeviceLike[]> { return this.fetchDevices(); }
    getDebugObservedSources(deviceId: string): DeviceDebugObservedSources | null {
        return getDebugObservedSources(this.observationState, deviceId);
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
            this.logger.log('Device API unavailable from SDK, running without realtime device updates');
            this.logger.structuredLog?.info({
                component: 'devices',
                event: 'device_api_init_skipped',
                reasonCode: 'sdk_api_missing',
                realtimeListenerAttached: false,
            });
            this.logger.debug('Homey SDK API unavailable, skipping init');
            return;
        }

        try {
            await initHomeyHttpClient(this.homey);
        } catch (error) {
            const normalizedError = normalizeError(error);
            this.logger.error('Failed to initialize HTTP client, continuing in degraded mode', normalizedError);
            this.logger.structuredLog?.error({
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
        this.logger.structuredLog?.info({
            component: 'devices',
            event: 'device_api_initialized',
        });
        this.logger.log('Device API initialized from SDK');
    }

    async refreshSnapshot(options: { includeLivePower?: boolean; targetedRefresh?: boolean } = {}): Promise<void> {
        const stopSpan = startRuntimeSpan('device_snapshot_refresh');
        const start = Date.now();
        try {
            const previousSnapshot = this.latestSnapshot;
            const isTargetedRefresh = options.targetedRefresh === true && this.latestSnapshot.length > 0;
            let fetchResult: Awaited<ReturnType<typeof fetchDevicesWithFallback>>;
            try {
                fetchResult = isTargetedRefresh
                    ? await this.fetchDevicesByKnownIds()
                    : await this.fetchDevicesForSnapshot();
            } catch (error) {
                const normalizedError = normalizeError(error);
                this.logger.structuredLog?.error({
                    event: 'device_snapshot_refresh_failed',
                    reasonCode: 'refresh_failed',
                    targetedRefresh: isTargetedRefresh,
                    err: normalizedError,
                });
                return;
            }
            const { devices: list, fetchSource } = fetchResult;
            const livePowerReport = options.includeLivePower === false
                ? buildEmptyLivePowerReport()
                : await this.fetchLivePowerReport();
            this.updateHomePowerFromReport(livePowerReport);
            const effectiveList = list.map((device) => this.applyDeviceDriverOverride(device));
            syncNativeSteppedLoadCommandAdapters({ owner: this, devices: effectiveList,
                shouldTrackDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId) });
            const snapshot = this.parseDeviceList(effectiveList, livePowerReport.byDeviceId);
            mergeFresherCapabilityObservations({
                state: this.observationState,
                previousSnapshot,
                nextSnapshot: snapshot,
                devices: effectiveList,
                targetedRefreshPollAtMs: isTargetedRefresh ? start : undefined,
                logger: this.logger,
            });
            this.setSnapshot(snapshot);
            this.liveFeed?.updateTrackedDevices(snapshot.map((d) => d.id));
            recordSnapshotRefreshObservations({
                state: this.observationState,
                snapshot,
                fetchSource,
            });
            this.logger.debug(`Device snapshot refreshed: ${snapshot.length} devices found`);
            if (this.logger.structuredLog) {
                const metrics = summarizeSnapshotRefreshMetrics(snapshot);
                if (this.shouldEmitSnapshotRefreshLog(snapshot.length, metrics)) {
                    this.logger.structuredLog.info({
                        event: 'device_snapshot_refresh_completed',
                        durationMs: Date.now() - start,
                        devicesTotal: snapshot.length,
                        targetedRefresh: isTargetedRefresh,
                        ...metrics,
                    });
                }
            }
            logEvSnapshotChanges({
                logger: this.logger,
                previousSnapshot,
                nextSnapshot: snapshot,
            });
        } finally {
            stopSpan();
            addPerfDuration('device_refresh_ms', Date.now() - start);
        }
    }

    updateLocalSnapshot(
        deviceId: string,
        updates: { target?: number | null; targetCapabilityId?: string; on?: boolean },
    ): void {
        const snap = this.latestSnapshot.find((d) => d.id === deviceId);
        if (!snap) return;

        if (typeof updates.target === 'number' && snap.targets?.length) {
            const entry = updates.targetCapabilityId
                ? snap.targets.find((t) => t.id === updates.targetCapabilityId)
                : snap.targets[0];
            if (entry) {
                entry.value = updates.target;
                snap.lastLocalWriteMs = Date.now();
            }
        }
        if (typeof updates.on === 'boolean') {
            snap.currentOn = updates.on;
            snap.lastLocalWriteMs = Date.now();
        }
    }

    getPeriodicStatusMetrics(): ({ devicesTotal: number } & SnapshotRefreshMetrics) | null {
        if (this.latestSnapshot.length === 0) return null;
        return {
            devicesTotal: this.latestSnapshot.length,
            ...summarizeSnapshotRefreshMetrics(this.latestSnapshot),
        };
    }

    private shouldEmitSnapshotRefreshLog(
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
        if (this.lastSnapshotRefreshMetricsKey === nextKey) return false;
        this.lastSnapshotRefreshMetricsKey = nextKey;
        return true;
    }

    async setCapability(deviceId: string, capabilityId: string, value: unknown): Promise<unknown> {
        if (!hasRestClient()) throw new Error('REST client not ready');
        const normalizedValue = this.normalizeCapabilityValue(deviceId, capabilityId, value);
        const snapshotBefore = this.latestSnapshot.find((device) => device.id === deviceId);
        const writeCapabilityId = (
            snapshotBefore?.controlCapabilityId === capabilityId
              ? snapshotBefore.controlWriteCapabilityId ?? capabilityId
              : capabilityId
        );
        logEvCapabilityRequest({
            logger: this.logger,
            snapshotBefore,
            deviceId,
            capabilityId,
            value: normalizedValue,
        });

        incPerfCounter('device_action_total');
        incPerfCounter(`device_action.capability.${capabilityId}`);
        recordLocalCapabilityWrite({
            recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
            deviceId,
            capabilityId,
            value: normalizedValue,
        });
        startPendingBinarySettleWindow({
            state: this.binarySettleState,
            deps: this.getBinarySettleDeps(),
            deviceId,
            capabilityId,
            value: normalizedValue,
            deviceName: snapshotBefore?.name,
        });
        try {
            await setRawCapabilityValue(deviceId, writeCapabilityId, normalizedValue);
        } catch (error) {
            clearLocalCapabilityWrite({
                recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
                deviceId,
                capabilityId,
            });
            clearPendingBinarySettleWindow(this.binarySettleState, deviceId, capabilityId);
            throw error;
        }

        // Keep local binary turn-off optimistic, but let binary turn-on stay pending until
        // telemetry confirms it. A restore request is intent, not observed truth.
        const preservedLocalState = typeof normalizedValue === 'boolean'
            && isRealtimeControlCapability(capabilityId)
            && normalizedValue === false;
        if (preservedLocalState) {
            this.updateLocalSnapshot(deviceId, { on: normalizedValue });
        }

        recordLocalWriteObservation({
            state: this.observationState,
            latestSnapshot: this.latestSnapshot,
            deviceId,
            capabilityId,
            value: normalizedValue,
            preservedLocalState,
        });

        const snapshotAfter = this.latestSnapshot.find((device) => device.id === deviceId);
        logEvCapabilityAccepted({
            logger: this.logger,
            snapshotAfter,
            deviceId,
            capabilityId,
            value: normalizedValue,
        });
        return normalizedValue;
    }

    async applyDeviceTargets(targets: Record<string, number>, contextInfo = ''): Promise<void> {
        if (!this.sdkReady) {
            this.logger.debug('SDK API not available, cannot apply device targets');
            return;
        }
        for (const device of this.latestSnapshot) {
            const targetValue = targets[device.id];
            if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;
            const targetCap = device.targets?.[0]?.id;
            if (!targetCap) continue;
            try {
                const appliedValue = await this.setCapability(device.id, targetCap, targetValue);
                this.logger.log(`Set ${targetCap} for ${device.name} to ${String(appliedValue)} (${contextInfo})`);
            } catch (error) {
                this.logger.error(`Failed to set ${targetCap} for ${device.name}`, error);
            }
        }
        await this.refreshSnapshot();
    }

    previewDeviceTargets(targets: Record<string, number>, contextInfo = ''): void {
        for (const device of this.latestSnapshot) {
            const targetValue = targets[device.id];
            if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;
            const targetCap = device.targets?.[0]?.id;
            if (!targetCap) continue;
            const target = device.targets.find((entry) => entry.id === targetCap);
            const normalizedValue = typeof targetValue === 'number'
                ? normalizeTargetCapabilityValue({ target, value: targetValue })
                : targetValue;
            this.logger.log(
                `Dry-run: would set ${targetCap} for ${device.name} `
                + `to ${normalizedValue}°C (${contextInfo})`,
            );
        }
    }

    private normalizeCapabilityValue(deviceId: string, capabilityId: string, value: unknown): unknown {
        if (typeof value !== 'number' || !Number.isFinite(value)) return value;
        const snapshot = this.latestSnapshot.find((device) => device.id === deviceId);
        const target = snapshot?.targets.find((entry) => entry.id === capabilityId);
        if (!target) return value;
        return normalizeTargetCapabilityValue({ target, value });
    }
    private async fetchDevices(): Promise<HomeyDeviceLike[]> { return (await this.fetchDevicesForSnapshot()).devices; }

    private async fetchDevicesForSnapshot(): Promise<{
        devices: HomeyDeviceLike[];
        fetchSource: DeviceFetchSource;
    }> {
        const start = Date.now();
        try {
            return await fetchDevicesWithFallback({
                logger: this.logger,
            });
        } finally {
            const durationMs = Date.now() - start;
            addPerfDuration('device_fetch_ms', durationMs);
            addPerfDuration('device_fetch_full_ms', durationMs);
        }
    }

    private async fetchDevicesByKnownIds(): Promise<{
        devices: HomeyDeviceLike[];
        fetchSource: DeviceFetchSource;
    }> {
        const start = Date.now();
        try {
            const deviceIds = this.latestSnapshot.map((d) => d.id);
            return await fetchDevicesByIds({
                deviceIds,
                logger: this.logger,
            });
        } finally {
            const durationMs = Date.now() - start;
            addPerfDuration('device_fetch_ms', durationMs);
            addPerfDuration('device_fetch_targeted_ms', durationMs);
        }
    }

    private async fetchLivePowerReport(): Promise<LivePowerReport> {
        return fetchLivePowerReport({ logger: this.logger });
    }

    private updateHomePowerFromReport(report: LivePowerReport): number | null {
        this.latestHomePowerW = report.homePowerW;
        return report.homePowerW;
    }
    getLiveFeedHealth(): LiveFeedHealth | null { return this.liveFeed?.getHealth() ?? null; }

    private shouldTrackRealtimeDevice(deviceId: string): boolean {
        return this.providers.getManaged ? this.providers.getManaged(deviceId) === true : true;
    }

    private applyDeviceDriverOverride(device: HomeyDeviceLike): HomeyDeviceLike {
        return applyDeviceDriverOverride(
            device,
            this.providers.getDeviceDriverIdOverride?.(getDeviceId(device)),
        );
    }

    public destroy(): void {
        void this.liveFeed?.stop();
        this.liveFeed = null;
        clearAllPendingBinarySettleWindows(this.binarySettleState);
        this.removeAllListeners();
    }

    private parseDeviceList(
        list: HomeyDeviceLike[],
        livePowerWByDeviceId: LiveDevicePowerWatts = {},
    ): TargetDeviceSnapshot[] {
        return parseDeviceList({ list, livePowerWByDeviceId, deps: this.getParseDeviceDeps() });
    }

    private parseDevice(
        device: HomeyDeviceLike,
        now: number,
        livePowerWByDeviceId: LiveDevicePowerWatts,
    ): TargetDeviceSnapshot | null {
        return parseDevice({ device, now, livePowerWByDeviceId, deps: this.getParseDeviceDeps() });
    }

    private getParseDeviceDeps() {
        return {
            logger: this.logger,
            providers: this.providers,
            powerState: this.powerState,
            measuredPowerResolver: this.measuredPowerResolver,
            getCapabilityObj: (device: HomeyDeviceLike) => this.getCapabilityObj(device),
            isPowerCapable: (
                device: HomeyDeviceLike,
                capsStatus: { targetCaps: string[]; hasPower: boolean },
                powerEstimate: ReturnType<typeof estimatePower>,
            ) => isDevicePowerCapable({ device, capsStatus, powerEstimate }),
            resolveLatestLocalWriteMs: (deviceId: string) => resolveLatestLocalWriteMs(this.observationState, deviceId),
        };
    }

    private getBinarySettleDeps() {
        return {
            logger: this.logger,
            recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
            isLiveFeedHealthy: () => this.liveFeed?.isHealthy() === true,
            shouldTrackRealtimeDevice: (deviceId: string) => this.shouldTrackRealtimeDevice(deviceId),
            getSnapshotById: (deviceId: string) => this.latestSnapshotById.get(deviceId),
            emitPlanReconcile: (event: PlanRealtimeUpdateEvent) => (
                this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, event)
            ),
        }; }
    private syncLatestSnapshotIndex(): void { this.latestSnapshotById
        = new Map(this.latestSnapshot.map((device) => [device.id, device])); }

    private getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
        return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
            ? device.capabilitiesObj as DeviceCapabilityMap
            : {};
    }
}

function summarizeSnapshotRefreshMetrics(snapshot: TargetDeviceSnapshot[]): SnapshotRefreshMetrics {
    let availableDevices = 0;
    let temperatureKnownDevices = 0;
    let unavailableDevices = 0;
    for (const device of snapshot) {
        if (device.available === false) {
            unavailableDevices++;
            continue;
        }
        availableDevices++;
        if (device.currentTemperature != null) temperatureKnownDevices++;
    }
    return {
        availableDevices,
        temperatureKnownDevices,
        temperatureUnknownDevices: availableDevices - temperatureKnownDevices,
        unavailableDevices,
    };
}
