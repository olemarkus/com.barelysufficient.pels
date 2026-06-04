/* eslint-disable max-lines -- Transport coordinates SDK setup, snapshots, realtime, and writes. */
import Homey from 'homey';
import { EventEmitter } from 'events';
import type {
  BinaryControlObservation,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { getDeviceId } from './transport/managerHelpers';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { estimatePower, type PowerEstimateState } from './devicePowerEstimate';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import {
  resolveEvChargingStateBinaryEvidence,
  resolveEvCurrentOn,
  logEvCapabilityAccepted,
  logEvCapabilityRequest,
  logEvSnapshotChanges,
  toCapabilityTimestampMs,
  type DeviceCapabilityMap,
} from './managerControl';
import { normalizeTargetCapabilityValue } from '../utils/targetCapabilities';
import { type LiveDevicePowerWatts } from './managerEnergy';
import { DeviceMeasuredPowerResolver } from './measuredPowerResolver';
import {
  fetchDevicesByIds,
  fetchDevicesWithFallback,
  fetchLivePowerReport,
  type LivePowerReport,
} from './transport/managerFetch';
import { isRealtimeControlCapability } from './managerRuntime';
import {
  clearLocalCapabilityWrite,
  formatBinaryState,
  formatTargetValue,
  getRecentLocalCapabilityWrite,
  recordLocalCapabilityWrite,
  type RecentLocalCapabilityWrites,
} from './transport/managerRealtimeSupport';
import {
  hasRestClient,
  initHomeyHttpClient,
  resolveHomeyInstance,
  setRawCapabilityValue,
} from './transport/managerHomeyApi';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import { createDeviceLiveFeed, type DeviceLiveFeed, type LiveFeedHealth } from './liveFeed';
import {
  didMeasurePowerBecomeSignificantlyPositive,
  handleRealtimeDeviceUpdate,
  type ObservedDeviceStateEvent,
  type PlanRealtimeUpdateEvent,
} from './transport/managerRealtimeHandlers';
import type { DeviceFetchSource } from './transport/managerFetch';
import { normalizeError } from '../utils/errorUtils';
import { shouldEmitWindowed } from '../logging/logDedupe';
// Binary-settle operations live in observer (`lib/observer/binarySettle.ts`)
// per PR #4 of the observer/transport split. Production wiring (`app.ts`)
// supplies the ops bag and the binary-settle state via DI so the transport
// call sites don't import observer's symbols at runtime. The defaults below
// are inert (no-op stubs + empty state) — tests or legacy callers that need
// real settle behaviour pass real observer ops through the constructor
// options. `BinarySettleState` is type-only-imported further down (re-export
// preserved for backward compatibility); no value edge into observer remains.
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
  type DeviceTransportObservationState,
} from './transport/managerObservation';
import {
  isDevicePowerCapable,
  parseDevice,
  parseDeviceList,
  type DeviceTransportParseProviders,
  type ParseDevicePurpose,
} from './transport/managerParseDevice';
import { applyDeviceDriverOverride } from './transport/managerParseIdentity';
import {
    buildNativeEvObservationDevice,
    normalizeNativeEvCapabilityUpdate,
} from './nativeEvWiring';
import {
  observeNativeSteppedLoadCapabilityUpdate,
  resolveObservedNativeSteppedLoadReportedStepId,
  setObservedNativeSteppedLoadStep,
  syncNativeSteppedLoadCommandAdapters,
} from './managerNativeSteppedCommand';
import { applyFreshnessOnlyCapabilityUpdate } from './transport/managerFreshness';
import {
  isNativeSteppedLoadControlEnabled,
  isNativeSteppedLoadControlCapabilityId,
  resolveNativeSteppedLoadReportedStepId,
  resolveTargetPowerReportedStepId,
} from './nativeSteppedLoadWiring';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  type SteppedLoadStepRequestResult,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { isStateOfChargeCapabilityId } from './transport/stateOfCharge';
import { applyDeviceCompatibilityMetadata } from './compatibility';
import type { DeviceObservation } from './deviceObservation';

const moduleLogger = getLogger('device/transport');

const MIN_SIGNIFICANT_POWER_W = 5;
const REALTIME_CAPABILITY_EVENT_WINDOW_MS = 2 * 1000;

// Homey SDK device reads can transiently return an empty list without throwing
// (see lib/device/transport/managerFetch.ts, which normalizes `[]`/`{}` into an
// empty list and returns successfully — so the fetch retry loop never engages).
// Treating a single empty read as authoritative would clobber a populated
// snapshot. Mirror the abandon-grace pattern in
// lib/objectives/deferredObjectives/planHistory.ts: only accept an empty
// snapshot once it has persisted for a grace window OR across enough consecutive
// reads, so a genuinely-emptied home still commits but a transient blip does not.
const EMPTY_SNAPSHOT_ABANDON_GRACE_MS = 5 * 60 * 1000;
const EMPTY_SNAPSHOT_ABANDON_GRACE_READS = 3;
export const PLAN_RECONCILE_REALTIME_UPDATE_EVENT = 'plan_reconcile_realtime_update';
export const PLAN_LIVE_STATE_OBSERVED_EVENT = 'plan_live_state_observed';
export type { DeviceDebugObservedSource, DeviceDebugObservedSources } from './transport/managerObservation';

const createEstimateDecisionLogState = (): Map<string, { signature: string; emittedAt: number }> => new Map();
const createPeakPowerLogState = (): Map<string, { signature: string; emittedAt: number }> => new Map();
const buildEmptyLivePowerReport = (): LivePowerReport => ({ byDeviceId: {}, homePowerW: null, deviceCount: 0 });

type DeviceTransportPowerState = PowerEstimateState & {
    lastPositiveMeasuredPowerKw?: Record<string, { kw: number; ts: number }>;
};

export type SnapshotRefreshMetrics = {
    availableDevices: number;
    temperatureKnownDevices: number;
    temperatureUnknownDevices: number;
    unavailableDevices: number;
};

type SteppedLoadFlowTriggerCard = {
    trigger: (tokens?: object, state?: object) => Promise<unknown> | unknown;
};

/**
 * State container owned by observer (`lib/observer/binarySettle.ts`).
 * Re-exported here as a type so downstream callers (wiring, tests) get
 * the exact same shape via DeviceTransport's surface. Type-only imports
 * are not surfaced by dep-cruiser's default behaviour, so this re-export
 * does not cross the `no-device-to-peer-except-power` cruiser rule —
 * no carve-out is needed (the inert default ops bag below decoupled
 * transport from any value import of observer in PR #4).
 */
export type { BinarySettleState } from '../observer/binarySettle';
import type { BinarySettleState } from '../observer/binarySettle';

type BinarySettleObservationCursor = {
  observationSeq?: number;
  observedAtMs?: number;
};

type BinarySettleOutcome = 'settled' | 'drift' | 'none';

type BinarySettleReconcileEvent = {
    deviceId: string;
    observationSeq?: number;
    observedAtMs?: number;
    name?: string;
    capabilityId?: string;
    changes?: Array<{
        capabilityId: string;
        previousValue: string;
        nextValue: string;
    }>;
};

/**
 * Structural mirror of observer's `BinarySettleDeps`. Defined locally
 * so transport doesn't have to reference observer's type directly.
 */
export type BinarySettleDepsForTransport = {
    logger: {
        structuredLog?: {
            info?: (payload: Record<string, unknown>) => void;
        };
    };
    clearLocalCapabilityWrite: (params: { deviceId: string; capabilityId: string }) => void;
    isLiveFeedHealthy: () => boolean;
    shouldTrackRealtimeDevice: (deviceId: string) => boolean;
    getSnapshotById: (deviceId: string) => TargetDeviceSnapshot | undefined;
    emitPlanReconcile: (event: BinarySettleReconcileEvent) => void;
};

/**
 * Observer-owned binarySettle operation bag. Wiring (`lib/app/`) builds
 * this against `lib/observer/binarySettle.ts`'s functions and passes it
 * to `DeviceTransport`. When omitted (legacy tests that construct
 * `DeviceTransport` directly), the transport falls back to its own
 * inert no-op stubs so behavior degrades gracefully. Transport supplies
 * `deps` at call time because some of those callbacks (e.g.
 * `emitPlanReconcile`) close over transport's own emitter.
 */
export type DeviceTransportBinarySettleOps = {
    start(params: {
        state: BinarySettleState;
        deps: BinarySettleDepsForTransport;
        deviceId: string;
        capabilityId: string;
        value: unknown;
        deviceName?: string;
    }): void;
    note(params: {
        state: BinarySettleState;
        deps: BinarySettleDepsForTransport;
        deviceId: string;
        capabilityId: string;
        value: boolean;
        source: 'realtime_capability' | 'device_update';
        ensureEventFields?: () => BinarySettleObservationCursor;
    }): BinarySettleOutcome;
    hasWindow(state: BinarySettleState, deviceId: string, capabilityId: string): boolean;
    clear(state: BinarySettleState, deviceId: string, capabilityId: string): void;
    clearAll(state: BinarySettleState): void;
};

/**
 * Structural mirror of observer's `ObservedStateEmitterDispatcher` from
 * `lib/observer/observedStateEvents.ts`. Defined locally so transport does
 * not have to reference observer's type directly — the cruiser still blocks
 * any `lib/device/` → `lib/observer/` import (`no-device-to-peer-except-power`).
 *
 * See PR #5 of the observer/transport split
 * (`notes/state-management/observer-transport-split.md`).
 */
export type TransportObservedStateDispatcher = {
    observedStateChanged: (event: ObservedDeviceStateEvent) => void;
    planReconcile: (event: PlanRealtimeUpdateEvent) => void;
    /**
     * Push the whole-home power scalar resolved from a Homey SDK energy report
     * into observer's home-power holder. PR2a of the observer/transport split:
     * observer owns the home-power read; transport produces the value and hands
     * it over here, no longer caching it locally.
     */
    setHomePowerW: (w: number | null) => void;
};

type DeviceTransportOptions = {
    debugStructured?: StructuredDebugEmitter;
    getFlowTriggerCard?: (cardId: string) => SteppedLoadFlowTriggerCard | undefined;
    /**
     * Fired after a snapshot mutation that may yield a new calibration sample
     * for a stepped-load device (measure_power value changed, or reportedStepId
     * changed). Consumers are responsible for their own eligibility checks.
     */
    onSnapshotMutated?: (snapshot: TargetDeviceSnapshot, nowMs: number) => void;
    /**
     * Observer-owned binarySettle state. When omitted (legacy tests),
     * transport falls back to inert no-op behaviour. When supplied,
     * observer owns the state and transport routes all reads/writes
     * through the injected `binarySettleOps` callbacks.
     */
    binarySettleState?: BinarySettleState;
    /**
     * Observer-owned binarySettle operation bag. See
     * `DeviceTransportBinarySettleOps` and PR #4 of the
     * observer/transport split.
     */
    binarySettleOps?: DeviceTransportBinarySettleOps;
    /**
     * Predicate consulted by transport's realtime parse pipeline to decide
     * whether an incoming binary capability change is the device's reply to
     * an in-flight write. Backed by observer's binarySettle store (and,
     * post-#5, by the pending-binary-command store too) — observer owns
     * the state; transport never reaches into observer directly. When the
     * predicate is omitted, the suppression site falls back to the
     * injected `binarySettleOps.hasWindow` (if available) or returns
     * `false` so legacy tests degrade gracefully.
     *
     * See notes/state-management/observer-transport-split.md (PR #4).
     */
    pendingPredicate?: (deviceId: string, capabilityId: string) => boolean;
    /**
     * Observer-owned dispatcher consulted by transport after translation of
     * each realtime event. Wiring (`lib/app/`) builds the dispatcher against
     * `lib/observer/observedStateEvents.ts`'s `ObservedStateEmitter`. When
     * supplied, observer is the single source of truth for the post-translation
     * fan-out and transport does not emit through its own EventEmitter.
     *
     * When omitted (legacy direct-`DeviceTransport` tests), transport falls
     * back to emitting `PLAN_LIVE_STATE_OBSERVED_EVENT` and
     * `PLAN_RECONCILE_REALTIME_UPDATE_EVENT` through its own EventEmitter so
     * existing `deviceManager.on(...)` test subscriptions keep working with
     * the same event-name strings.
     *
     * See PR #5 of the observer/transport split
     * (`notes/state-management/observer-transport-split.md`).
     */
    observedStateDispatcher?: TransportObservedStateDispatcher;
};

export class DeviceTransport extends EventEmitter implements DeviceObservation {
    private sdkReady = false;
    private liveFeed: DeviceLiveFeed | null = null;
    private logger: Logger;
    private homey: Homey.App;
    private latestSnapshot: TargetDeviceSnapshot[] = [];
    private latestSnapshotById: Map<string, TargetDeviceSnapshot> = new Map();
    // Tracks a run of transient empty SDK reads while a populated snapshot is held,
    // so we only abandon the populated snapshot after the grace window/read count.
    private emptySnapshotGrace: { firstSeenMs: number; reads: number } | null = null;
    private latestTrackedDevicesById: Map<string, HomeyDeviceLike> = new Map();
    private latestRawDevices: HomeyDeviceLike[] = [];
    private powerState: Required<PowerEstimateState>;
    private measuredPowerResolver: DeviceMeasuredPowerResolver;
    private recentLocalCapabilityWrites: RecentLocalCapabilityWrites = new Map();
    private latestBinarySettleEvidenceByDeviceId: Map<string, BinaryControlObservation> = new Map();
    private binarySettleState: BinarySettleState;
    private binarySettleOps: DeviceTransportBinarySettleOps;
    private observationState: DeviceTransportObservationState = createObservationState();
    private observationSeqByDeviceId: Map<string, number> = new Map();
    private recentRealtimeCapabilityEventLogByKey: Map<string, number> = new Map();
    private lastSnapshotRefreshMetricsKey: string | null = null;
    private providers: DeviceTransportParseProviders = {};
    private getFlowTriggerCard: DeviceTransportOptions['getFlowTriggerCard'] | undefined;
    private onSnapshotMutated: DeviceTransportOptions['onSnapshotMutated'] | undefined;
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
            const handledTargetPowerSourceUpdate = this.handleTargetPowerSourceCapabilityUpdate({
                snapshotIndex,
                deviceId,
                capabilityId: normalizedEvent.capabilityId,
                value: normalizedEvent.value,
                snapshot,
            });
            if (handledTargetPowerSourceUpdate) continue;

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
                && this.consultPendingPredicate(deviceId, effectiveCapabilityId);
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
        const { isNativePowerStepUpdate } = updateKind;

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

        const fallbackReportedStepId = profile && value === false
            ? resolveNativeSteppedLoadReportedStepId({
                profile,
                capabilities: [],
                capabilityObj: {
                    onoff: { value: false },
                },
            })
            : undefined;
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
        });
        return isNativePowerStepUpdate;
    }

    private handleTargetPowerSourceCapabilityUpdate(params: {
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
        if (capabilityId !== 'available_installation_current') return false;
        const phaseCount = resolveTargetPowerPresetPhaseCount(snapshot.targetPowerConfig?.preset);
        if (!phaseCount || typeof value !== 'number' || !Number.isFinite(value)) return false;
        const profile = snapshot.suggestedSteppedLoadProfile ?? snapshot.steppedLoadProfile;
        if (profile?.model !== 'stepped_load') return false;
        const targetPowerW = Math.round(value * 230 * phaseCount);
        const nextReportedStepId = resolveTargetPowerReportedStepId({
            profile,
            capabilityObj: {
                target_power: { value: targetPowerW },
            },
        });
        recordCapabilityObservation({
            state: this.observationState,
            latestSnapshot: this.latestSnapshot,
            deviceId,
            capabilityId,
            value,
            source: 'realtime_capability',
        });
        this.applyNativeSteppedLoadSnapshotUpdate({
            snapshotIndex,
            deviceId,
            nextReportedStepId,
            isNativePowerStepUpdate: true,
        });
        return true;
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
        const cursor = this.nextObservationCursor(deviceId);
        (this.logger.structuredLog ?? moduleLogger).info({
            event: 'realtime_capability_drift',
            deviceId,
            capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
            changes: [change],
        });
        this.dispatchObservedStateChanged({
            source: 'realtime_capability',
            deviceId,
            ...cursor,
            capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        });
        this.dispatchPlanReconcile({
            deviceId,
            ...cursor,
            name: deviceName,
            changes: [change],
        });
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
        if (capabilityId === 'measure_power' && snapshot) {
            this.onSnapshotMutated?.(snapshot, Date.now());
        }
        const cursor = this.nextObservationCursor(deviceId);
        this.dispatchObservedStateChanged({
            source: 'realtime_capability',
            deviceId,
            ...cursor,
            capabilityId,
            measurePowerBecameSignificantlyPositive: capabilityId === 'measure_power'
                && didMeasurePowerBecomeSignificantlyPositive(
                    previousPowerKw,
                    snapshot?.measuredPowerKw,
                    MIN_SIGNIFICANT_POWER_W,
                ),
        });
        if (reconcileChange && snapshot) {
            (this.logger.structuredLog ?? moduleLogger).info({
                event: 'realtime_capability_drift',
                deviceId,
                capabilityId: reconcileChange.capabilityId,
                changes: [reconcileChange],
            });
            this.dispatchPlanReconcile({
                deviceId,
                ...cursor,
                name: snapshot.name,
                changes: [reconcileChange],
            });
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
        (this.logger.structuredLog ?? moduleLogger).info({
            event: 'realtime_capability_drift',
            deviceId,
            capabilityId,
            changes,
        });
        this.recordRealtimeCapabilityObservation({
            deviceId,
            eventCapabilityId: capabilityId,
            observedCapabilityIds: [capabilityId],
        }, changes.length > 0);
        const cursor = this.nextObservationCursor(deviceId);
        this.dispatchObservedStateChanged({
            source: 'realtime_capability',
            deviceId,
            ...cursor,
            capabilityId,
        });
        this.dispatchPlanReconcile({
            deviceId,
            ...cursor,
            name: snapshot.name,
            changes,
        });
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
    } | null {
        const { capabilityId, value, snapshot } = params;
        const isNativePowerStepUpdate = capabilityId === 'target_power'
            ? true
            : isNativeSteppedLoadControlCapabilityId({
                capabilityId,
                capabilities: snapshot.capabilities ?? [],
                capabilityObj: {
                    [capabilityId]: { value },
                },
            });
        const isNativeBinaryUpdate = capabilityId === snapshot.controlCapabilityId && typeof value === 'boolean';
        if (!isNativePowerStepUpdate && !isNativeBinaryUpdate) {
            return null;
        }
        return {
            isNativePowerStepUpdate,
        };
    }

    private applyNativeSteppedLoadSnapshotUpdate(params: {
        snapshotIndex: number;
        deviceId: string;
        nextReportedStepId: string | undefined;
        isNativePowerStepUpdate: boolean;
    }): void {
        const {
            snapshotIndex,
            deviceId,
            nextReportedStepId,
            isNativePowerStepUpdate,
        } = params;
        const currentSnapshot = this.latestSnapshot[snapshotIndex];
        const previousReportedStepId = currentSnapshot.reportedStepId;
        if (nextReportedStepId) currentSnapshot.reportedStepId = nextReportedStepId;
        else delete currentSnapshot.reportedStepId;
        if (isNativePowerStepUpdate) {
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
            this.onSnapshotMutated?.(currentSnapshot, Date.now());
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

    private nextObservationCursor(deviceId: string): Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'> {
        const observationSeq = (this.observationSeqByDeviceId.get(deviceId) ?? 0) + 1;
        this.observationSeqByDeviceId.set(deviceId, observationSeq);
        return {
            observationSeq,
            observedAtMs: Date.now(),
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
        const hasSettleWindow = this.binarySettleOps.hasWindow(this.binarySettleState, deviceId, capabilityId);
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
        let settleCursor: Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'> | undefined;
        const ensureSettleCursor = (): Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'> => {
            settleCursor ??= this.nextObservationCursor(deviceId);
            return settleCursor;
        };
        const settleOutcome = isSettlementEvidence
            ? this.binarySettleOps.note({
                state: this.binarySettleState,
                deps: this.getBinarySettleDeps(),
                deviceId,
                capabilityId,
                value,
                source: 'realtime_capability',
                ensureEventFields: ensureSettleCursor,
            })
            : 'none';
        if (settleOutcome !== 'none') {
            // Record the observation so freshness tracking advances even for settle events.
            this.recordRealtimeCapabilityObservation({
                deviceId,
                eventCapabilityId: capabilityId,
                observedCapabilityIds: [capabilityId],
            }, false, ensureSettleCursor());
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
    }, deferObservedEvent = false, cursor?: Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'>): void {
        const { deviceId, eventCapabilityId, observedCapabilityIds } = params;
        recordSnapshotCapabilityObservations({
            state: this.observationState,
            latestSnapshot: this.latestSnapshot,
            deviceId,
            source: 'realtime_capability',
            capabilityIds: observedCapabilityIds,
        });
        if (deferObservedEvent) return;
        this.dispatchObservedStateChanged({
            source: 'realtime_capability',
            deviceId,
            ...(cursor ?? this.nextObservationCursor(deviceId)),
            capabilityId: eventCapabilityId,
        });
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
        let settleCursor: Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'> | undefined;
        const ensureSettleCursor = (): Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'> => {
            settleCursor ??= this.nextObservationCursor(deviceId);
            return settleCursor;
        };
        const settleOutcome = this.binarySettleOps.note({
            state: this.binarySettleState,
            deps: this.getBinarySettleDeps(),
            deviceId,
            capabilityId: acceptedObservation.capabilityId,
            value: acceptedObservation.observedValue,
            source: 'realtime_capability',
            ensureEventFields: ensureSettleCursor,
        });
        if (settleOutcome === 'none') return false;
        this.recordRealtimeCapabilityObservation({
            deviceId,
            eventCapabilityId,
            observedCapabilityIds: acceptedObservation.observedCapabilityIds,
        }, false, ensureSettleCursor());
        return true;
    }

    private readonly handleRealtimeDeviceUpdate = (device: HomeyDeviceLike): void => {
        const deviceId = getDeviceId(device);
        if (deviceId && !this.shouldTrackRealtimeDevice(deviceId)) {
            this.clearBinarySettleEvidence(deviceId);
            this.latestTrackedDevicesById.delete(deviceId);
        }
        const effectiveDevice = this.applyDeviceDriverOverride(device);
        const previousSnapshot = this.latestSnapshotById.get(deviceId);
        const binarySafeUpdate = deviceId
            ? this.clearInvalidBinarySettleEvidenceFromDeviceUpdate(deviceId, effectiveDevice, previousSnapshot)
            : { device: effectiveDevice, hadInvalidBinaryControlPayload: false };
        const { device: binarySafeDevice, hadInvalidBinaryControlPayload } = binarySafeUpdate;
        if (deviceId && this.shouldTrackRealtimeDevice(deviceId)) {
            this.latestTrackedDevicesById.set(deviceId, binarySafeDevice);
            this.syncTrackedNativeSteppedLoadAdapters();
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
            notePendingBinarySettleObservation: (nextDeviceId, capabilityId, value, source, ensureEventFields) => (
                this.binarySettleOps.note({
                    state: this.binarySettleState,
                    deps: this.getBinarySettleDeps(),
                    deviceId: nextDeviceId,
                    capabilityId,
                    value,
                    source,
                    ensureEventFields,
                })
            ),
            hasPendingBinarySettleWindow: (nextDeviceId, capabilityId) => (
                this.consultPendingPredicate(nextDeviceId, capabilityId)
            ),
            emitDeviceUpdateProcessed: (event) => {
              const emit = this.debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p));
              emit(event);
            },
            createObservationCursor: (nextDeviceId) => this.nextObservationCursor(nextDeviceId),
            emitPlanReconcile: (event) => this.emitPlanReconcileEvent(event),
            emitObservedState: (event: ObservedDeviceStateEvent) => this.dispatchObservedStateChanged(event),
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
        if (currentSnapshot && this.didSnapshotChangeCalibrationInputs({
            previousSnapshot,
            currentSnapshot,
            observedCapabilityIds: result.observedCapabilityIds,
        })) {
            this.onSnapshotMutated?.(currentSnapshot, Date.now());
        }
    };

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
    private shouldDeferEmptySnapshotCommit(
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
            this.emptySnapshotGrace = null;
            return false;
        }
        const grace = this.emptySnapshotGrace ?? { firstSeenMs: nowMs, reads: 0 };
        grace.reads += 1;
        this.emptySnapshotGrace = grace;
        const elapsedMs = nowMs - grace.firstSeenMs;
        if (elapsedMs >= EMPTY_SNAPSHOT_ABANDON_GRACE_MS
            || grace.reads >= EMPTY_SNAPSHOT_ABANDON_GRACE_READS) {
            (this.logger.structuredLog ?? moduleLogger).warn({
                component: 'devices',
                event: 'device_snapshot_empty_grace_exceeded',
                reasonCode: 'empty_snapshot_committed',
                consecutiveEmptyReads: grace.reads,
                graceElapsedMs: elapsedMs,
                previousDevicesTotal: previousSnapshot.length,
            });
            this.emptySnapshotGrace = null;
            return false;
        }
        (this.logger.structuredLog ?? moduleLogger).warn({
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
     * Commits a refreshed snapshot unless the abandon-grace guard defers it.
     * Returns `true` when committed, `false` when a transient empty read was held
     * back so the caller can skip the post-commit recording/logging.
     */
    private commitRefreshedSnapshot(params: {
        snapshot: TargetDeviceSnapshot[];
        previousSnapshot: readonly TargetDeviceSnapshot[];
        rawWasEmpty: boolean;
        nowMs: number;
    }): boolean {
        const { snapshot, previousSnapshot, rawWasEmpty, nowMs } = params;
        if (this.shouldDeferEmptySnapshotCommit(snapshot, previousSnapshot, rawWasEmpty, nowMs)) return false;
        this.setSnapshot(snapshot);
        this.liveFeed?.updateTrackedDevices(snapshot.map((d) => d.id));
        this.fireSnapshotMutatedForRefresh(snapshot, previousSnapshot);
        return true;
    }

    private fireSnapshotMutatedForRefresh(
        snapshot: readonly TargetDeviceSnapshot[],
        previousSnapshot: readonly TargetDeviceSnapshot[],
    ): void {
        if (!this.onSnapshotMutated) return;
        const previousByDeviceId = new Map(previousSnapshot.map((entry) => [entry.id, entry]));
        const nowMs = Date.now();
        for (const entry of snapshot) {
            if (this.didSnapshotChangeCalibrationInputs({
                previousSnapshot: previousByDeviceId.get(entry.id),
                currentSnapshot: entry,
                observedCapabilityIds: [],
            })) {
                this.onSnapshotMutated(entry, nowMs);
            }
        }
    }

    private didSnapshotChangeCalibrationInputs(params: {
        previousSnapshot: TargetDeviceSnapshot | undefined;
        currentSnapshot: TargetDeviceSnapshot;
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
                incomingSeam: 'push',
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
                    incomingSeam: 'pull',
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
        // The transport seam the contradicting read came in on. A `pull`
        // (snapshot refresh) value with no timestamp may be Homey serving a
        // cached capability, so it must not erase a fresher pushed observation.
        // A `push` (device.update) is the device actively reporting its current
        // state, so it stays authoritative even without a timestamp.
        incomingSeam: 'pull' | 'push';
    }): void {
        const {
            deviceId,
            snapshot,
            capabilityId,
            observedValue,
            incomingSeam,
        } = params;
        const existing = this.latestBinarySettleEvidenceByDeviceId.get(deviceId);
        if (!existing || existing.capabilityId !== capabilityId || existing.observedValue === observedValue) return;
        // A timestamp-less PULL read carries no evidence it is newer than a
        // pushed observation, so it must not erase a realtime/device_update
        // observation (notes/state-management/CLAUDE.md "Never let an older full
        // fetch erase a fresher local or realtime observation without evidence
        // it is newer"). A genuine state change arrives via a push (realtime
        // listener / device.update), so the retained evidence stays supersedable
        // by any newer stamped read or push. The trusted observation wins and
        // currentOn reconciles to it. A timestamp-less PUSH is not held: it is
        // the device reporting its current state and stays authoritative.
        if (
            incomingSeam === 'pull'
            && (existing.source === 'realtime_capability' || existing.source === 'device_update')
        ) {
            this.applyBinarySettleEvidenceToSnapshot(snapshot, existing);
            return;
        }
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
        (this.logger.structuredLog ?? moduleLogger).error({
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
    private pendingPredicate: DeviceTransportOptions['pendingPredicate'] | undefined;
    private observedStateDispatcher: TransportObservedStateDispatcher | undefined;

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
    }
    /* eslint-enable complexity */

    getSnapshot(): TargetDeviceSnapshot[] { return this.latestSnapshot; }
    getSnapshotByDeviceId(deviceId: string): TargetDeviceSnapshot | undefined {
        return this.latestSnapshotById.get(deviceId);
    }
    getUiPickerDevices(): TargetDeviceSnapshot[] {
        if (this.latestRawDevices.length === 0) return [];
        return parseDeviceList({
            list: this.latestRawDevices,
            previousSnapshotById: this.latestSnapshotById,
            deps: this.getParseDeviceDeps(),
            purpose: 'ui_picker',
        });
    }
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
    parseDeviceListForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] {
        const effectiveList = list.map((device) => this.applyDeviceDriverOverride(device));
        this.syncTrackedDevices(effectiveList);
        return this.parseDeviceList(effectiveList, {}, 'unfiltered');
    }
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
            (this.logger.structuredLog ?? moduleLogger).info({
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
                (this.logger.structuredLog ?? moduleLogger).error({
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
                logger: this.logger,
            });
            this.reconcileBinarySettleEvidenceAfterSnapshotRefresh(snapshot, effectiveList);
            // Skip both the snapshot commit AND the raw-device cache update when the
            // abandon-grace guard defers a transient empty read, so getUiPickerDevices()
            // doesn't briefly report zero devices during the blip we're masking.
            const committed = this.commitRefreshedSnapshot({
                snapshot,
                previousSnapshot,
                rawWasEmpty: effectiveList.length === 0,
                nowMs: start,
            });
            if (!committed) return;
            this.adoptCommittedDeviceList(effectiveList, isTargetedRefresh);
            recordSnapshotRefreshObservations({
                state: this.observationState,
                snapshot,
                fetchSource,
            });
            (this.debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
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
        this.binarySettleOps.start({
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
            this.binarySettleOps.clear(this.binarySettleState, deviceId, capabilityId);
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

    async requestSteppedLoadStep(params: {
        deviceId: string;
        profile: SteppedLoadProfile;
        desiredStepId: string;
        planningPowerW: number;
        planningCurrentA: number;
        actuationMode?: 'plan' | 'reconcile';
        previousStepId?: string;
    }): Promise<SteppedLoadStepRequestResult> {
        const {
            deviceId,
            profile,
            desiredStepId,
            planningPowerW,
            planningCurrentA,
            actuationMode,
            previousStepId,
        } = params;
        const snapshot = this.latestSnapshotById.get(deviceId);
        if (snapshot && isNativeSteppedLoadControlEnabled(snapshot)) {
            const nativeRequested = await setObservedNativeSteppedLoadStep({
                owner: this,
                deviceId,
                profile,
                desiredStepId,
                setCapability: (capabilityId, value) => this.setCapability(deviceId, capabilityId, value),
                logger: this.logger,
            });
            return nativeRequested ? { requested: true, transport: 'native_capability' } : { requested: false };
        }

        const triggerCard = this.resolveSteppedLoadFlowTriggerCard();
        if (!triggerCard?.trigger) return { requested: false };

        const triggerPromise = triggerCard.trigger({
            step_id: desiredStepId,
            planning_power_w: planningPowerW,
            planning_current_a: planningCurrentA,
            previous_step_id: previousStepId ?? '',
        }, {
            deviceId,
        });
        void Promise.resolve(triggerPromise).catch((error: unknown) => {
            const normalizedError = normalizeError(error);
            (this.logger.structuredLog ?? moduleLogger).error({
                event: 'stepped_load_command_failed',
                reasonCode: 'flow_trigger_failed',
                deviceId,
                deviceName: snapshot?.name,
                desiredStepId,
                planningPowerW,
                commandTransport: 'flow',
                ...(actuationMode ? { mode: actuationMode } : {}),
                err: normalizedError,
            });
            this.logger.error(
                `Failed to trigger stepped-load command for device ${deviceId}`,
                normalizedError,
            );
        });
        return { requested: true, transport: 'flow' };
    }

    private resolveSteppedLoadFlowTriggerCard(): SteppedLoadFlowTriggerCard | undefined {
        return this.getFlowTriggerCard?.('desired_stepped_load_changed');
    }

    private emitCapabilityWriteDebug(params: {
        event: 'device_capability_write_requested' | 'device_capability_write_accepted';
        deviceId: string;
        deviceName?: string;
        capabilityId: string;
        writeCapabilityId: string;
        value: unknown;
    }): void {
        (this.debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
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
        // PR2a of the observer/transport split: observer owns the home-power
        // read. Transport produces the scalar from the Homey SDK energy report
        // and pushes it to observer's holder via the injected dispatcher; it no
        // longer caches the value locally. The return value still feeds the
        // direct `pollHomePowerW()` caller (homey_energy poll source).
        this.observedStateDispatcher?.setHomePowerW(report.homePowerW);
        return report.homePowerW;
    }
    getLiveFeedHealth(): LiveFeedHealth | null { return this.liveFeed?.getHealth() ?? null; }

    private shouldTrackRealtimeDevice(deviceId: string): boolean {
        return this.providers.getManaged ? this.providers.getManaged(deviceId) === true : true;
    }

    private applyDeviceDriverOverride(device: HomeyDeviceLike): HomeyDeviceLike {
        const compatibleDevice = applyDeviceCompatibilityMetadata(device);
        return applyDeviceDriverOverride(
            compatibleDevice,
            this.providers.getDeviceDriverIdOverride?.(getDeviceId(device)),
        );
    }

    public destroy(): void {
        void this.liveFeed?.stop();
        this.liveFeed = null;
        this.binarySettleOps.clearAll(this.binarySettleState);
        this.latestBinarySettleEvidenceByDeviceId.clear();
        this.latestTrackedDevicesById.clear();
        this.removeAllListeners();
    }

    // Snapshot pipeline contract: callers must pass an already-effective device
    // list (compatibility metadata + driver-id override pre-applied via
    // `this.applyDeviceDriverOverride`). `refreshSnapshot` and
    // `parseDeviceListForTests` are the two entry points; both pre-apply the
    // override exactly once so it propagates downstream without being re-run by
    // this wrapper or by `resolveParseDeviceIdentity` inside `parseDevice`.
    // Parsing is side-effect-free; the realtime tracking map and native adapters
    // are (re)built separately via `syncTrackedDevices`, which `refreshSnapshot`
    // runs only after the abandon-grace guard commits the snapshot.
    private parseDeviceList(
        effectiveList: HomeyDeviceLike[],
        livePowerWByDeviceId: LiveDevicePowerWatts = {},
        purpose: ParseDevicePurpose = 'runtime',
    ): TargetDeviceSnapshot[] {
        return parseDeviceList({
            list: effectiveList,
            livePowerWByDeviceId,
            previousSnapshotById: this.latestSnapshotById,
            deps: this.getParseDeviceDeps(),
            purpose,
        });
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
    private syncTrackedDevices(effectiveList: HomeyDeviceLike[]): void {
        this.latestTrackedDevicesById = new Map(
            effectiveList
                .map((device) => [getDeviceId(device), device] as const)
                .filter(([deviceId]) => Boolean(deviceId) && this.shouldTrackRealtimeDevice(deviceId)),
        );
        this.syncTrackedNativeSteppedLoadAdapters();
    }

    // Adopt the side effects of a committed snapshot: rebuild the tracking map /
    // native adapters and refresh the raw-device cache. Run only after the
    // abandon-grace guard commits, so a deferred transient empty read leaves the
    // previously-tracked devices, their native adapters, and the raw cache intact.
    private adoptCommittedDeviceList(effectiveList: HomeyDeviceLike[], isTargetedRefresh: boolean): void {
        this.syncTrackedDevices(effectiveList);
        if (!isTargetedRefresh) this.latestRawDevices = effectiveList;
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
            providers: this.providers,
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
        if (this.observedStateDispatcher) {
            this.observedStateDispatcher.observedStateChanged(event);
            return;
        }
        this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, event);
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

    private getBinarySettleDeps() {
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
            emitPlanReconcile: (event: PlanRealtimeUpdateEvent) => this.emitPlanReconcileEvent(event),
        }; }
    private syncLatestSnapshotIndex(): void { this.latestSnapshotById
        = new Map(this.latestSnapshot.map((device) => [device.id, device])); }

    private getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
        return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
            ? device.capabilitiesObj as DeviceCapabilityMap
            : {};
    }

    private syncTrackedNativeSteppedLoadAdapters(): void {
        syncNativeSteppedLoadCommandAdapters({
            owner: this,
            devices: [...this.latestTrackedDevicesById.values()],
            shouldTrackDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
            logger: this.logger,
        });
    }
}

function isRawBinarySettlementEvidenceAllowed(
    snapshot: TargetDeviceSnapshot,
    capabilityId: string,
): boolean {
    return capabilityId !== 'evcharger_charging' || snapshot.evChargingState === undefined;
}

function resolveTargetPowerPresetPhaseCount(
    preset: string | undefined,
): number | undefined {
    if (preset === 'ev_charger_1_phase') return 1;
    if (preset === 'ev_charger_3_phase') return 3;
    return undefined;
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

/**
 * Inert binarySettle ops bag for tests and legacy callers that construct
 * `DeviceTransport` directly without supplying a real ops bag. Production
 * wiring (`app.ts`) always provides a real bag built against
 * `lib/observer/binarySettle.ts`; this default exists only so a no-arg
 * constructor stays usable. Tests that exercise binary-settle behaviour
 * pass real observer ops through the constructor options.
 */
function createInertBinarySettleOps(): DeviceTransportBinarySettleOps {
    return {
        start: () => {},
        note: () => 'none',
        hasWindow: () => false,
        clear: () => {},
        clearAll: () => {},
    };
}

function createEmptyBinarySettleState(): BinarySettleState {
    return { pendingBinarySettleWindows: new Map() };
}
