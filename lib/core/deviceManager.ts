/* eslint-disable max-lines -- Device manager coordinates SDK setup, snapshots, realtime updates, and command writes. */
import Homey from 'homey';
import { EventEmitter } from 'events';
import { BinaryControlObservation, HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import { getDeviceId } from './deviceManagerHelpers';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { estimatePower, type PowerEstimateState } from './powerEstimate';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import {
    resolveEvChargingStateBinaryEvidence,
    resolveEvCurrentOn,
    logEvCapabilityAccepted,
    logEvCapabilityRequest,
    logEvSnapshotChanges,
    toCapabilityTimestampMs,
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
    resolveObservedNativeSteppedLoadStatus,
    syncNativeSteppedLoadCommandAdapters,
} from './deviceManagerNativeSteppedCommand';
import { applyFreshnessOnlyCapabilityUpdate } from './deviceManagerFreshness';
import {
    isNativeSteppedLoadControlEnabled,
    resolveNativeSteppedLoadCapabilityId,
    resolveNativeSteppedLoadReportedStepId,
} from './nativeSteppedLoadWiring';
import { PELS_MEASURE_STEP_CAPABILITY_ID } from './steppedLoadSyntheticCapabilities';
import { isStateOfChargeCapabilityId } from './deviceStateOfCharge';

const MIN_SIGNIFICANT_POWER_W = 5;
const REALTIME_CAPABILITY_EVENT_WINDOW_MS = 2 * 1000;
export const PLAN_RECONCILE_REALTIME_UPDATE_EVENT = 'plan_reconcile_realtime_update';
export const PLAN_LIVE_STATE_OBSERVED_EVENT = 'plan_live_state_observed';
export type { DeviceDebugObservedSource, DeviceDebugObservedSources } from './deviceManagerObservation';

const createEstimateDecisionLogState = (): Map<string, { signature: string; emittedAt: number }> => new Map();
const createPeakPowerLogState = (): Map<string, { signature: string; emittedAt: number }> => new Map();
const buildEmptyLivePowerReport = (): LivePowerReport => ({ byDeviceId: {}, homePowerW: null, deviceCount: 0 });

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
    private latestBinarySettleEvidenceByDeviceId: Map<string, BinaryControlObservation> = new Map();
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

        const updateKind = this.resolveNativeSteppedCapabilityUpdateKind({
            capabilityId,
            value,
            snapshot,
        });
        if (!updateKind) return false;
        const { isNativePowerStepUpdate, isZaptecAdapterObservation } = updateKind;

        const normalizedValue = this.normalizeRealtimeCapabilityEventValue(capabilityId, value);
        if (this.hasMatchingRecentLocalWrite(deviceId, capabilityId, normalizedValue)) {
            return isNativePowerStepUpdate;
        }

        observeNativeSteppedLoadCapabilityUpdate({
            owner: this,
            deviceId,
            capabilityId,
            value,
            logger: this.logger,
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

        this.applyNativeSteppedLoadSnapshotUpdate({
            snapshotIndex,
            deviceId,
            nextReportedStepId,
            isNativePowerStepUpdate,
            isZaptecAdapterObservation,
        });
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
        if (this.handleFreshnessBinaryObservation({
            snapshot,
            deviceId,
            eventCapabilityId: capabilityId,
            binaryControlObservation: result.binaryControlObservation,
        })) return;
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
        if (
            capabilityId === snapshot.controlCapabilityId
            && (capabilityId === 'onoff' || capabilityId === 'evcharger_charging')
            && typeof value !== 'boolean'
        ) {
            this.clearBinarySettleEvidenceForInvalidControlPayload({
                deviceId,
                deviceName: snapshot.name,
                capabilityId,
                source: 'realtime_capability',
                value,
            });
            return;
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
        this.recordRealtimeCapabilityObservation({
            deviceId,
            eventCapabilityId: capabilityId,
            observedCapabilityIds: [capabilityId],
        });
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
            || capabilityId === 'evcharger_charging_state'
            || isStateOfChargeCapabilityId(capabilityId);
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
            if (capabilityId === 'measure_power' || capabilityId === 'meter_power') return Math.round(value);
            if (capabilityId.includes('temperature')) return Math.round(value * 10) / 10;
            return Math.round(value * 100) / 100;
        }
        if (typeof value === 'string') return value.trim();
        return value;
    }

    private resolveNativeSteppedCapabilityUpdateKind(params: {
        capabilityId: string;
        value: unknown;
        snapshot: TargetDeviceSnapshot;
    }): {
        isNativePowerStepUpdate: boolean;
        isZaptecAdapterObservation: boolean;
    } | null {
        const { capabilityId, value, snapshot } = params;
        const nativeCapabilityId = resolveNativeSteppedLoadCapabilityId([capabilityId]);
        const isNativePowerStepUpdate = nativeCapabilityId !== undefined;
        const isNativeBinaryUpdate = capabilityId === snapshot.controlCapabilityId && typeof value === 'boolean';
        const isZaptecAdapterObservation = capabilityId === 'available_installation_current'
            || capabilityId === 'measure_power';
        if (!isNativePowerStepUpdate && !isNativeBinaryUpdate && !isZaptecAdapterObservation) {
            return null;
        }
        return {
            isNativePowerStepUpdate,
            isZaptecAdapterObservation,
        };
    }

    private applyNativeSteppedLoadSnapshotUpdate(params: {
        snapshotIndex: number;
        deviceId: string;
        nextReportedStepId: string | undefined;
        isNativePowerStepUpdate: boolean;
        isZaptecAdapterObservation: boolean;
    }): void {
        const {
            snapshotIndex,
            deviceId,
            nextReportedStepId,
            isNativePowerStepUpdate,
            isZaptecAdapterObservation,
        } = params;
        const currentSnapshot = this.latestSnapshot[snapshotIndex];
        currentSnapshot.nativeSteppedLoadStatus = resolveObservedNativeSteppedLoadStatus({
            owner: this,
            deviceId,
        });
        if (currentSnapshot.nativeSteppedLoadStatus?.blockedReasonCode) {
            delete currentSnapshot.suggestedSteppedLoadProfile;
        }
        const previousReportedStepId = currentSnapshot.reportedStepId;
        if (nextReportedStepId) currentSnapshot.reportedStepId = nextReportedStepId;
        else delete currentSnapshot.reportedStepId;
        if (isNativePowerStepUpdate || isZaptecAdapterObservation) {
            currentSnapshot.lastFreshDataMs = Date.now();
            currentSnapshot.lastUpdated = currentSnapshot.lastFreshDataMs;
        }
        if (previousReportedStepId !== nextReportedStepId) {
            this.emitNativeSteppedLoadReportedStepChanged({
                deviceId,
                deviceName: currentSnapshot.name,
                previousReportedStepId,
                nextReportedStepId,
            });
        }
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
        const snapshot = this.latestSnapshot[snapshotIndex];
        const previousCurrentOn = snapshot.currentOn;
        // Check the settle window before the equality check so a confirmation
        // observation (value === currentOn) can still settle it.
        const hasSettleWindow = hasPendingBinarySettleWindow(this.binarySettleState, deviceId, capabilityId);
        const isSettlementEvidence = isRawBinarySettlementEvidenceAllowed(snapshot, capabilityId);
        if (hasSettleWindow && isSettlementEvidence) {
            this.applyBinaryObservationToSnapshot(snapshot, capabilityId, value, 'realtime_capability');
        }
        if (hasSettleWindow && !isSettlementEvidence) {
            if (capabilityId === 'evcharger_charging') {
                snapshot.currentOn = resolveEvCurrentOn({
                    evChargingState: snapshot.evChargingState,
                    evchargerCharging: snapshot.evCharging,
                });
            }
            this.recordRealtimeCapabilityObservation({
                deviceId,
                eventCapabilityId: capabilityId,
                observedCapabilityIds: [capabilityId],
            });
            return true;
        }
        const settleOutcome = isSettlementEvidence
            ? notePendingBinarySettleObservation({
                state: this.binarySettleState,
                deps: this.getBinarySettleDeps(),
                deviceId,
                capabilityId,
                value,
                source: 'realtime_capability',
            })
            : 'none';
        if (settleOutcome !== 'none') {
            // Record the observation so freshness tracking advances even for settle events.
            this.recordRealtimeCapabilityObservation({
                deviceId,
                eventCapabilityId: capabilityId,
                observedCapabilityIds: [capabilityId],
            });
            return true; // reconcile already emitted by settle window on drift; none needed on settle
        }

        if (!hasSettleWindow) {
            this.applyBinaryObservationToSnapshot(snapshot, capabilityId, value, 'realtime_capability');
        }
        if (snapshot.currentOn === previousCurrentOn) return false;
        changes.push({
            capabilityId,
            previousValue: formatBinaryState(previousCurrentOn),
            nextValue: formatBinaryState(snapshot.currentOn),
        });
        return false;
    }

    private recordRealtimeCapabilityObservation(params: {
        deviceId: string;
        eventCapabilityId: string;
        observedCapabilityIds: string[];
    }): void {
        const { deviceId, eventCapabilityId, observedCapabilityIds } = params;
        recordSnapshotCapabilityObservations({
            state: this.observationState,
            latestSnapshot: this.latestSnapshot,
            deviceId,
            source: 'realtime_capability',
            capabilityIds: observedCapabilityIds,
        });
        this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, {
            source: 'realtime_capability',
            deviceId,
            capabilityId: eventCapabilityId,
        } satisfies ObservedDeviceStateEvent);
    }

    private applyBinaryObservationToSnapshot(
        snapshot: TargetDeviceSnapshot,
        capabilityId: string,
        value: boolean,
        source: BinaryControlObservation['source'],
    ): void {
        const mutableSnapshot = snapshot;
        const observedAtMs = Date.now();
        if (capabilityId === 'evcharger_charging') {
            mutableSnapshot.evCharging = value;
            mutableSnapshot.currentOn = resolveEvCurrentOn({
                evChargingState: mutableSnapshot.evChargingState,
                evchargerCharging: value,
            });
            if (!isRawBinarySettlementEvidenceAllowed(mutableSnapshot, capabilityId)) return;
        } else {
            mutableSnapshot.currentOn = value;
        }
        if (capabilityId === 'onoff' || capabilityId === 'evcharger_charging') {
            const evidence: BinaryControlObservation = {
                valid: true,
                capabilityId,
                observedValue: value,
                observedCapabilityIds: [capabilityId],
                observedAtMs,
                source,
            };
            this.applyBinarySettleEvidenceToSnapshot(mutableSnapshot, evidence);
        }
    }

    private handleFreshnessBinaryObservation(params: {
        snapshot: TargetDeviceSnapshot;
        deviceId: string;
        eventCapabilityId: string;
        binaryControlObservation?: BinaryControlObservation;
    }): boolean {
        const {
            snapshot,
            deviceId,
            eventCapabilityId,
            binaryControlObservation,
        } = params;
        const acceptedObservation = binaryControlObservation
            ? this.persistBinarySettleEvidenceToSnapshot(snapshot, binaryControlObservation)
            : undefined;
        if (!acceptedObservation) {
            if (eventCapabilityId === 'evcharger_charging_state') {
                this.clearBinarySettleEvidence(deviceId);
                delete snapshot.binaryControlObservation;
            }
            return false;
        }
        const settleOutcome = notePendingBinarySettleObservation({
            state: this.binarySettleState,
            deps: this.getBinarySettleDeps(),
            deviceId,
            capabilityId: acceptedObservation.capabilityId,
            value: acceptedObservation.observedValue,
            source: 'realtime_capability',
        });
        if (settleOutcome === 'none') return false;
        this.recordRealtimeCapabilityObservation({
            deviceId,
            eventCapabilityId,
            observedCapabilityIds: acceptedObservation.observedCapabilityIds,
        });
        return true;
    }

    private readonly handleRealtimeDeviceUpdate = (device: HomeyDeviceLike): void => {
        const deviceId = getDeviceId(device);
        if (deviceId && !this.shouldTrackRealtimeDevice(deviceId)) {
            this.clearBinarySettleEvidence(deviceId);
        }
        const effectiveDevice = this.applyDeviceDriverOverride(device);
        const previousSnapshot = this.latestSnapshotById.get(deviceId);
        const binarySafeUpdate = deviceId
            ? this.clearInvalidBinarySettleEvidenceFromDeviceUpdate(deviceId, effectiveDevice, previousSnapshot)
            : { device: effectiveDevice, hadInvalidBinaryControlPayload: false };
        const { device: binarySafeDevice, hadInvalidBinaryControlPayload } = binarySafeUpdate;
        if (deviceId && this.shouldTrackRealtimeDevice(deviceId)) {
            observeNativeSteppedLoadCommandAdapter({
                owner: this,
                deviceId,
                device: binarySafeDevice,
                clearWhenUnavailable: true,
                logger: this.logger,
                sharedInstallationBlocked: previousSnapshot?.nativeSteppedLoadStatus?.blockedReasonCode
                    === 'zaptec_stepped_blocked_shared_installation',
            });
        }
        const observedDevice = buildNativeEvObservationDevice({
            device: binarySafeDevice,
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
            emitDeviceUpdateProcessed: (event) => this.debugStructured?.(event),
            emitPlanReconcile: (event) => this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, event),
            emitObservedState: (event: ObservedDeviceStateEvent) => this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, event),
        });
        const currentSnapshot = deviceId
            ? this.syncRealtimeDeviceUpdateSnapshot({
                deviceId,
                currentSnapshot: result.currentSnapshot,
                previousSnapshot,
                preservePreviousSnapshot: hadInvalidBinaryControlPayload,
            })
            : null;
        if (deviceId) {
            this.applyBinarySettleEvidenceFromDeviceUpdate({
                deviceId,
                device: observedDevice,
                snapshot: currentSnapshot,
                previousSnapshot,
                skipInvalidControlPayload: hadInvalidBinaryControlPayload,
            });
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

    private syncRealtimeDeviceUpdateSnapshot(params: {
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
            this.latestSnapshotById.set(deviceId, currentSnapshot);
            return currentSnapshot;
        }
        if (preservePreviousSnapshot && previousSnapshot) {
            if (!this.latestSnapshot.some((snapshot) => snapshot.id === deviceId)) {
                this.latestSnapshot.push(previousSnapshot);
            }
            this.latestSnapshotById.set(deviceId, previousSnapshot);
            return previousSnapshot;
        }
        this.latestSnapshotById.delete(deviceId);
        return null;
    }

    private clearInvalidBinarySettleEvidenceFromDeviceUpdate(
        deviceId: string,
        device: HomeyDeviceLike,
        previousSnapshot: TargetDeviceSnapshot | undefined,
    ): { device: HomeyDeviceLike; hadInvalidBinaryControlPayload: boolean } {
        if (!previousSnapshot) return { device, hadInvalidBinaryControlPayload: false };
        const payload = this.resolveBinaryControlPayload(device, previousSnapshot, previousSnapshot);
        if (!payload.present || typeof payload.value === 'boolean') {
            return { device, hadInvalidBinaryControlPayload: false };
        }
        this.clearBinarySettleEvidenceForInvalidControlPayload({
            deviceId,
            deviceName: previousSnapshot.name,
            capabilityId: payload.capabilityId,
            source: 'device_update',
            value: payload.value,
        });
        return { device, hadInvalidBinaryControlPayload: true };
    }

    private applyBinarySettleEvidenceFromDeviceUpdate(params: {
        deviceId: string;
        device: HomeyDeviceLike;
        snapshot: TargetDeviceSnapshot | null;
        previousSnapshot: TargetDeviceSnapshot | undefined;
        skipInvalidControlPayload?: boolean;
    }): void {
        const {
            deviceId,
            device,
            snapshot,
            previousSnapshot,
            skipInvalidControlPayload = false,
        } = params;
        if (!snapshot) {
            if (previousSnapshot) {
                const payload = this.resolveBinaryControlPayload(device, previousSnapshot, previousSnapshot);
                if (payload.present && typeof payload.value !== 'boolean') {
                    this.clearBinarySettleEvidenceForInvalidControlPayload({
                        deviceId,
                        deviceName: previousSnapshot.name,
                        capabilityId: payload.capabilityId,
                        source: 'device_update',
                        value: payload.value,
                    });
                    return;
                }
            }
            this.clearBinarySettleEvidence(deviceId);
            return;
        }
        const evStateHandled = this.applyEvStateSettleEvidenceFromDeviceUpdate({
            deviceId,
            device,
            snapshot,
        });
        if (evStateHandled) return;
        if (skipInvalidControlPayload) return;
        const payload = this.resolveBinaryControlPayload(device, snapshot, previousSnapshot);
        if (!payload.present) {
            this.applyCachedBinarySettleEvidenceToSnapshot(snapshot);
            return;
        }
        if (typeof payload.value !== 'boolean') {
            this.clearBinarySettleEvidenceForInvalidControlPayload({
                deviceId,
                deviceName: snapshot.name,
                capabilityId: payload.capabilityId,
                source: 'device_update',
                value: payload.value,
            });
            return;
        }
        if (!payload.capabilityId) return;
        if (payload.observedAtMs === undefined) {
            this.clearContradictoryBinarySettleEvidence({
                deviceId,
                snapshot,
                capabilityId: payload.capabilityId,
                observedValue: payload.value,
            });
            this.applyCachedBinarySettleEvidenceToSnapshot(snapshot);
            return;
        }
        const evidence: BinaryControlObservation = {
            valid: true,
            capabilityId: payload.capabilityId,
            observedValue: payload.value,
            observedCapabilityIds: [payload.observedCapabilityId],
            observedAtMs: payload.observedAtMs,
            source: 'device_update',
        };
        this.applyBinarySettleEvidenceToSnapshot(snapshot, evidence);
    }

    private applyEvStateSettleEvidenceFromDeviceUpdate(params: {
        deviceId: string;
        device: HomeyDeviceLike;
        snapshot: TargetDeviceSnapshot;
    }): boolean {
        const {
            deviceId,
            device,
            snapshot,
        } = params;
        if (snapshot.controlCapabilityId !== 'evcharger_charging') return false;
        const statePayload = this.readCapabilityValue(device, 'evcharger_charging_state');
        if (!statePayload.present) return false;
        const observedValue = resolveEvChargingStateBinaryEvidence(statePayload.value);
        if (observedValue === undefined || statePayload.observedAtMs === undefined) {
            this.clearBinarySettleEvidence(deviceId);
            delete snapshot.binaryControlObservation;
            return true;
        }
        const evidence: BinaryControlObservation = {
            valid: true,
            capabilityId: 'evcharger_charging',
            observedValue,
            observedCapabilityIds: ['evcharger_charging_state'],
            observedAtMs: statePayload.observedAtMs,
            source: 'device_update',
        };
        this.persistBinarySettleEvidenceToSnapshot(snapshot, evidence);
        return true;
    }

    private reconcileBinarySettleEvidenceAfterSnapshotRefresh(
        snapshot: TargetDeviceSnapshot[],
        devices: HomeyDeviceLike[],
    ): void {
        const devicesById = new Map<string, HomeyDeviceLike>();
        for (const device of devices) {
            const deviceId = getDeviceId(device);
            if (deviceId) devicesById.set(deviceId, device);
        }

        for (const deviceSnapshot of snapshot) {
            const sourceDevice = devicesById.get(deviceSnapshot.id);
            if (!sourceDevice) continue;
            if (sourceDevice && this.hasInvalidBinaryControlPayload(deviceSnapshot, sourceDevice)) {
                this.clearBinarySettleEvidenceForInvalidControlPayload({
                    deviceId: deviceSnapshot.id,
                    deviceName: deviceSnapshot.name,
                    capabilityId: deviceSnapshot.controlCapabilityId,
                    source: 'snapshot_refresh',
                    value: this.readCapabilityValue(
                        sourceDevice,
                        deviceSnapshot.controlObservationCapabilityId ?? deviceSnapshot.controlCapabilityId,
                    ).value,
                });
                continue;
            }
            if (this.shouldClearRawEvBinaryEvidenceForStatePayload(deviceSnapshot, sourceDevice)) {
                this.clearBinarySettleEvidence(deviceSnapshot.id);
                delete deviceSnapshot.binaryControlObservation;
                continue;
            }
            const payload = this.resolveBinaryControlPayload(sourceDevice, deviceSnapshot, deviceSnapshot);
            if (
                payload.present
                && payload.observedAtMs === undefined
                && typeof payload.value === 'boolean'
                && payload.capabilityId
            ) {
                this.clearContradictoryBinarySettleEvidence({
                    deviceId: deviceSnapshot.id,
                    snapshot: deviceSnapshot,
                    capabilityId: payload.capabilityId,
                    observedValue: payload.value,
                });
            }
        }
    }

    private shouldClearRawEvBinaryEvidenceForStatePayload(
        snapshot: TargetDeviceSnapshot,
        sourceDevice: HomeyDeviceLike,
    ): boolean {
        if (snapshot.controlCapabilityId !== 'evcharger_charging') return false;
        if (!this.readCapabilityValue(sourceDevice, 'evcharger_charging_state').present) return false;
        const evidence = snapshot.binaryControlObservation
            ?? this.latestBinarySettleEvidenceByDeviceId.get(snapshot.id);
        if (!evidence || evidence.capabilityId !== 'evcharger_charging') return false;
        return !evidence.observedCapabilityIds.includes('evcharger_charging_state');
    }

    private reconcileBinarySettleEvidenceWithSnapshot(snapshot: TargetDeviceSnapshot[]): void {
        const activeDeviceIds = new Set(snapshot.map((device) => device.id));
        for (const deviceId of this.latestBinarySettleEvidenceByDeviceId.keys()) {
            if (!activeDeviceIds.has(deviceId)) this.latestBinarySettleEvidenceByDeviceId.delete(deviceId);
        }
        for (const device of snapshot) {
            if (this.shouldClearBinarySettleEvidenceForSnapshot(device)) {
                this.clearBinarySettleEvidence(device.id);
                delete device.binaryControlObservation;
                continue;
            }
            const evidence = device.binaryControlObservation;
            if (evidence) {
                this.applyBinarySettleEvidenceToSnapshot(device, evidence);
                continue;
            }
            this.applyCachedBinarySettleEvidenceToSnapshot(device);
        }
    }

    private shouldClearBinarySettleEvidenceForSnapshot(snapshot: TargetDeviceSnapshot): boolean {
        return !this.shouldTrackRealtimeDevice(snapshot.id) || snapshot.managed === false;
    }

    private applyCachedBinarySettleEvidenceToSnapshot(snapshot: TargetDeviceSnapshot): void {
        const cached = this.latestBinarySettleEvidenceByDeviceId.get(snapshot.id);
        if (!cached) return;
        if (cached.capabilityId !== snapshot.controlCapabilityId) return;
        this.applyBinarySettleEvidenceToSnapshot(snapshot, cached);
    }

    private persistBinarySettleEvidenceToSnapshot(
        snapshot: TargetDeviceSnapshot,
        evidence: BinaryControlObservation,
    ): BinaryControlObservation {
        const acceptedEvidence = this.upsertBinarySettleEvidence(snapshot.id, evidence);
        const mutableSnapshot = snapshot;
        mutableSnapshot.binaryControlObservation = acceptedEvidence;
        return acceptedEvidence;
    }

    private applyBinarySettleEvidenceToSnapshot(
        snapshot: TargetDeviceSnapshot,
        evidence: BinaryControlObservation,
    ): BinaryControlObservation {
        const acceptedEvidence = this.upsertBinarySettleEvidence(snapshot.id, evidence);
        const mutableSnapshot = snapshot;
        if (acceptedEvidence.capabilityId === 'evcharger_charging') {
            mutableSnapshot.evCharging = acceptedEvidence.observedValue;
            mutableSnapshot.currentOn = resolveEvCurrentOn({
                evChargingState: mutableSnapshot.evChargingState,
                evchargerCharging: acceptedEvidence.observedValue,
            });
        } else {
            mutableSnapshot.currentOn = acceptedEvidence.observedValue;
        }
        mutableSnapshot.binaryControlObservation = acceptedEvidence;
        return acceptedEvidence;
    }

    private clearContradictoryBinarySettleEvidence(params: {
        deviceId: string;
        snapshot: TargetDeviceSnapshot;
        capabilityId: BinaryControlObservation['capabilityId'];
        observedValue: boolean;
    }): void {
        const {
            deviceId,
            snapshot,
            capabilityId,
            observedValue,
        } = params;
        const existing = this.latestBinarySettleEvidenceByDeviceId.get(deviceId);
        if (!existing || existing.capabilityId !== capabilityId || existing.observedValue === observedValue) return;
        this.clearBinarySettleEvidence(deviceId);
        delete snapshot.binaryControlObservation;
    }

    private upsertBinarySettleEvidence(
        deviceId: string,
        evidence: BinaryControlObservation,
    ): BinaryControlObservation {
        const existing = this.latestBinarySettleEvidenceByDeviceId.get(deviceId);
        if (existing && existing.observedAtMs > evidence.observedAtMs) {
            return cloneBinaryControlObservation(existing);
        }
        const next = cloneBinaryControlObservation(evidence);
        this.latestBinarySettleEvidenceByDeviceId.set(deviceId, next);
        return next;
    }

    private clearBinarySettleEvidence(deviceId: string): boolean {
        const removed = this.latestBinarySettleEvidenceByDeviceId.delete(deviceId);
        const snapshot = this.latestSnapshotById.get(deviceId)
            ?? this.latestSnapshot.find((device) => device.id === deviceId);
        if (snapshot) delete snapshot.binaryControlObservation;
        return removed;
    }

    private clearBinarySettleEvidenceForInvalidControlPayload(params: {
        deviceId: string;
        deviceName?: string;
        capabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
        source: BinaryControlObservation['source'];
        value: unknown;
    }): void {
        const {
            deviceId,
            deviceName,
            capabilityId,
            source,
            value,
        } = params;
        if (!capabilityId) return;
        const existing = this.latestBinarySettleEvidenceByDeviceId.get(deviceId);
        if (!existing || existing.capabilityId !== capabilityId) return;
        this.clearBinarySettleEvidence(deviceId);
        this.logger.structuredLog?.error({
            event: 'binary_settle_evidence_cleared',
            reasonCode: 'invalid_control_payload',
            deviceId,
            ...(deviceName ? { deviceName } : {}),
            capabilityId,
            source,
            valueType: typeof value,
        });
    }

    private resolveBinaryControlPayload(
        device: HomeyDeviceLike,
        snapshot: TargetDeviceSnapshot,
        previousSnapshot: TargetDeviceSnapshot | undefined,
    ): {
        present: boolean;
        capabilityId: TargetDeviceSnapshot['controlCapabilityId'];
        observedCapabilityId: string;
        value: unknown;
        observedAtMs?: number;
    } {
        const capabilityId = snapshot.controlCapabilityId ?? previousSnapshot?.controlCapabilityId;
        const observedCapabilityId = (
            snapshot.controlObservationCapabilityId
            ?? previousSnapshot?.controlObservationCapabilityId
            ?? capabilityId
        );
        if (!capabilityId || !observedCapabilityId) {
            return { present: false, capabilityId, observedCapabilityId: '', value: undefined };
        }
        return {
            capabilityId,
            observedCapabilityId,
            ...this.readCapabilityValue(device, observedCapabilityId),
        };
    }

    private hasInvalidBinaryControlPayload(snapshot: TargetDeviceSnapshot, device: HomeyDeviceLike): boolean {
        if (!snapshot.controlCapabilityId) return false;
        const observedCapabilityId = snapshot.controlObservationCapabilityId ?? snapshot.controlCapabilityId;
        const payload = this.readCapabilityValue(device, observedCapabilityId);
        return payload.present && typeof payload.value !== 'boolean';
    }

    private readCapabilityValue(device: HomeyDeviceLike, capabilityId: string | undefined): {
        present: boolean;
        value: unknown;
        observedAtMs?: number;
    } {
        if (!capabilityId || !device.capabilitiesObj) return { present: false, value: undefined };
        if (!Object.prototype.hasOwnProperty.call(device.capabilitiesObj, capabilityId)) {
            return { present: false, value: undefined };
        }
        const capability = device.capabilitiesObj[capabilityId];
        if (!Object.prototype.hasOwnProperty.call(capability ?? {}, 'value')) {
            return { present: false, value: undefined };
        }
        return {
            present: true,
            value: capability?.value,
            observedAtMs: toCapabilityTimestampMs(capability?.lastUpdated),
        };
    }

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
    setSnapshot(s: TargetDeviceSnapshot[]): void {
        this.latestSnapshot = s;
        this.syncLatestSnapshotIndex();
        this.reconcileBinarySettleEvidenceWithSnapshot(s);
    }
    injectDeviceUpdateForTest(device: HomeyDeviceLike): void { this.handleRealtimeDeviceUpdate(device); }
    injectCapabilityUpdateForTest(deviceId: string, capabilityId: string, value: unknown): void {
        this.handleRealtimeCapabilityUpdate(deviceId, capabilityId, value);
    }
    parseDeviceListForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] { return this.parseDeviceList(list); }
    async getDevicesForDebug(): Promise<HomeyDeviceLike[]> { return this.fetchDevices(); }
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
            const snapshot = this.parseDeviceList(effectiveList, livePowerReport.byDeviceId);
            mergeFresherCapabilityObservations({
                state: this.observationState,
                previousSnapshot,
                nextSnapshot: snapshot,
                devices: effectiveList,
                targetedRefreshPollAtMs: isTargetedRefresh ? start : undefined,
                logger: this.logger,
            });
            this.reconcileBinarySettleEvidenceAfterSnapshotRefresh(snapshot, effectiveList);
            this.setSnapshot(snapshot);
            this.liveFeed?.updateTrackedDevices(snapshot.map((d) => d.id));
            recordSnapshotRefreshObservations({
                state: this.observationState,
                snapshot,
                fetchSource,
            });
            this.debugStructured?.({
                event: 'device_snapshot_refresh_processed',
                devicesTotal: snapshot.length,
                targetedRefresh: isTargetedRefresh,
                fetchSource,
                homePowerW: livePowerReport.homePowerW,
                livePowerDeviceCount: livePowerReport.deviceCount,
            });
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
        this.emitCapabilityWriteDebug({
            event: 'device_capability_write_requested',
            deviceId,
            deviceName: snapshotBefore?.name,
            capabilityId,
            writeCapabilityId,
            value: normalizedValue,
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
        this.emitCapabilityWriteDebug({
            event: 'device_capability_write_accepted',
            deviceId,
            deviceName: snapshotBefore?.name,
            capabilityId,
            writeCapabilityId,
            value: normalizedValue,
        });

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

    private emitCapabilityWriteDebug(params: {
        event: 'device_capability_write_requested' | 'device_capability_write_accepted';
        deviceId: string;
        deviceName?: string;
        capabilityId: string;
        writeCapabilityId: string;
        value: unknown;
    }): void {
        this.debugStructured?.({
            event: params.event,
            deviceId: params.deviceId,
            deviceName: params.deviceName ?? null,
            capabilityId: params.capabilityId,
            writeCapabilityId: params.writeCapabilityId,
            value: params.value,
            valueType: typeof params.value,
        });
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
        return fetchLivePowerReport({ logger: this.logger, debugStructured: this.debugStructured });
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
        this.latestBinarySettleEvidenceByDeviceId.clear();
        this.removeAllListeners();
    }

    private parseDeviceList(
        list: HomeyDeviceLike[],
        livePowerWByDeviceId: LiveDevicePowerWatts = {},
    ): TargetDeviceSnapshot[] {
        syncNativeSteppedLoadCommandAdapters({
            owner: this,
            devices: list.map((device) => this.applyDeviceDriverOverride(device)),
            shouldTrackDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
            logger: this.logger,
        });
        return parseDeviceList({
            list,
            livePowerWByDeviceId,
            previousSnapshotById: this.latestSnapshotById,
            deps: this.getParseDeviceDeps(),
        });
    }

    private parseDevice(
        device: HomeyDeviceLike,
        now: number,
        livePowerWByDeviceId: LiveDevicePowerWatts,
    ): TargetDeviceSnapshot | null {
        return parseDevice({
            device,
            now,
            livePowerWByDeviceId,
            previousSnapshot: this.latestSnapshotById.get(getDeviceId(device)),
            deps: this.getParseDeviceDeps(),
        });
    }

    private getParseDeviceDeps() {
        return {
            logger: this.logger,
            providers: {
                ...this.providers,
                getNativeSteppedLoadStatus: (deviceId: string) => resolveObservedNativeSteppedLoadStatus({
                    owner: this,
                    deviceId,
                }),
            },
            debugStructured: this.debugStructured,
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

function isRawBinarySettlementEvidenceAllowed(
    snapshot: TargetDeviceSnapshot,
    capabilityId: string,
): boolean {
    return capabilityId !== 'evcharger_charging' || snapshot.evChargingState === undefined;
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

function cloneBinaryControlObservation(
    evidence: BinaryControlObservation,
): BinaryControlObservation {
    return {
        ...evidence,
        observedCapabilityIds: [...evidence.observedCapabilityIds],
    };
}
