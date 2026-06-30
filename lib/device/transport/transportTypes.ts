/**
 * Public type contracts + pure helpers for the `DeviceTransport` leaf and its
 * homey-free collaborator modules. Extracted from `deviceTransport.ts` so the
 * leaf stays focused on SDK wiring + orchestration.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { BinaryControlObservation, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { BinarySettleState } from '../../observer/binarySettle';
import type { PowerEstimateState } from '../devicePowerEstimate';
import type {
  ObservedDeviceStateEvent,
  ObservedDeviceStateRefreshEvent,
  PlanRealtimeUpdateEvent,
} from './managerRealtimeHandlers';
import type { LivePowerReport } from './managerFetch';

export const MIN_SIGNIFICANT_POWER_W = 5;
export const REALTIME_CAPABILITY_EVENT_WINDOW_MS = 2 * 1000;

export type DeviceTransportPowerState = PowerEstimateState & {
    lastPositiveMeasuredPowerKw?: Record<string, { kw: number; ts: number }>;
};

export type SnapshotRefreshMetrics = {
    availableDevices: number;
    temperatureKnownDevices: number;
    temperatureUnknownDevices: number;
    unavailableDevices: number;
};

export type SteppedLoadFlowTriggerCard = {
    trigger: (tokens?: object, state?: object) => Promise<unknown> | unknown;
};

export type BinarySettleObservationCursor = {
  observationSeq?: number;
  observedAtMs?: number;
};

export type BinarySettleOutcome = 'settled' | 'drift' | 'none';

export type BinarySettleReconcileEvent = {
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
    observedStateRefresh: (event: ObservedDeviceStateRefreshEvent) => void;
    planReconcile: (event: PlanRealtimeUpdateEvent) => void;
    /**
     * Push the whole-home power scalar resolved from a Homey SDK energy report
     * into observer's home-power holder. PR2a of the observer/transport split:
     * observer owns the home-power read; transport produces the value and hands
     * it over here, no longer caching it locally.
     */
    setHomePowerW: (w: number | null) => void;
    /**
     * Push the gross PV generation (W) resolved from the same energy report into
     * observer's holder, or `null` when absent. Used only to gross up the
     * authoritative whole-home actual consumption for the managed/unmanaged
     * split — it never reaches the hard-cap import path.
     */
    setGenerationW: (w: number | null) => void;
};

export type DeviceTransportOptions = {
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

export const createEstimateDecisionLogState = (): Map<string, { signature: string; emittedAt: number }> => new Map();
export const createPeakPowerLogState = (): Map<string, { signature: string; emittedAt: number }> => new Map();
export const buildEmptyLivePowerReport = (): LivePowerReport => ({
  byDeviceId: {}, homePowerW: null, generationW: null, deviceCount: 0,
});

export function isRawBinarySettlementEvidenceAllowed(
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
): boolean {
    return capabilityId !== 'evcharger_charging' || snapshot.evChargingState === undefined;
}

export function summarizeSnapshotRefreshMetrics(snapshot: TransportDeviceSnapshot[]): SnapshotRefreshMetrics {
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

export function cloneBinaryControlObservation(
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
export function createInertBinarySettleOps(): DeviceTransportBinarySettleOps {
    return {
        start: () => {},
        note: () => 'none',
        hasWindow: () => false,
        clear: () => {},
        clearAll: () => {},
    };
}

export function createEmptyBinarySettleState(): BinarySettleState {
    return { pendingBinarySettleWindows: new Map() };
}
