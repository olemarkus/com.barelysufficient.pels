/**
 * Public type contracts + pure helpers for the `DeviceTransport` leaf and its
 * homey-free collaborator modules. Extracted from `deviceTransport.ts` so the
 * leaf stays focused on SDK wiring + orchestration.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { BinaryControlObservation, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { EvCarLinkSnapshotAccess } from '../evCarLinkWiring';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { PowerEstimateState } from '../devicePowerEstimate';
import type {
  ObservedDeviceStateEvent,
  ObservedDeviceStateRefreshEvent,
  PlanRealtimeUpdateEvent,
} from './managerRealtimeHandlers';

/**
 * Hysteresis threshold for the binary-settle EDGE detector
 * (`didMeasurePowerBecomeSignificantlyPositive`): did this device just cross
 * from ~0 into meaningfully drawing? That is settlement evidence for an on/off
 * command, and a threshold is the right tool for it.
 *
 * It is NOT a measurement filter. `DeviceMeasuredPowerResolver` used to drop
 * any reading at or below this floor, which turned "drawing 3 W" into the same
 * answer as "has no `measure_power`" — and absence is what licenses a consumer
 * to substitute rated power, so a few watts of standby could be booked as
 * kilowatts. The resolver now reports every non-negative finite reading.
 * Do not reintroduce this constant there.
 */
export const MIN_SIGNIFICANT_POWER_W = 5;
export const REALTIME_CAPABILITY_EVENT_WINDOW_MS = 2 * 1000;

/**
 * Announced when a reading MOVES a device's learned peak — a new entry, a higher
 * one, or a re-anchored window. Deliberately NOT on `PowerEstimateState`: the
 * estimator only reads that bag, and this is a wiring seam.
 *
 * The learned-peak write-back hangs off this rather than the snapshot-mutation
 * seam, which fires on a CHANGED calibration input: a reading equal to the
 * standing peak changes none of them while still re-anchoring `observedAtMs`, so
 * the window of the steadiest devices would expire in settings while memory said
 * it was fresh.
 */
type LearnedPeakChangedListener = { onLearnedPeakChanged?: () => void };

export type DeviceTransportPowerState = PowerEstimateState & LearnedPeakChangedListener & {
    lastPositiveMeasuredPowerKw?: Record<string, { kw: number; ts: number }>;
};

/**
 * The transport's own power bag: every estimator field resolved, plus the
 * learned-peak notification the parse path forwards to `updateLastKnownPower`.
 */
export type ResolvedTransportPowerState = Required<PowerEstimateState> & LearnedPeakChangedListener;

export type SnapshotRefreshMetrics = {
    availableDevices: number;
    temperatureKnownDevices: number;
    temperatureUnknownDevices: number;
    unavailableDevices: number;
};

export type SteppedLoadFlowTriggerCard = {
    trigger: (tokens?: object, state?: object) => Promise<unknown> | unknown;
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
    observedControlStateChanged: (event: PlanRealtimeUpdateEvent) => void;
    /**
     * Push the whole-home power scalar resolved from a Homey SDK energy report
     * into observer's home-power holder. PR2a of the observer/transport split:
     * observer owns the home-power read; transport produces the value and hands
     * it over here, no longer caching it locally.
     */
    setHomePowerW: (w: number | null) => void;
    /**
     * Push the gross PV generation (W) resolved from the same energy report into
     * observer's holder, or `null` when absent, stamped with its read time. Used
     * to gross up the authoritative whole-home actual consumption for the
     * managed/unmanaged split, and to co-sample production on the flow source —
     * it never reaches the hard-cap import path.
     */
    setGenerationW: (w: number | null, observedAtMs: number) => void;
};

export type DeviceTransportOptions = {
    debugStructured?: StructuredDebugEmitter;
    /**
     * Persistence port for the EV car-link probe, supplied by the wiring layer.
     * Omitted in tests and any construction path that does not persist: the probe
     * still runs, it just forgets across restarts.
     */
    evCarLinkSnapshotAccess?: EvCarLinkSnapshotAccess;
    getFlowTriggerCard?: (cardId: string) => SteppedLoadFlowTriggerCard | undefined;
    /**
     * Fired after a snapshot mutation that may yield a new calibration sample
     * for a stepped-load device (measure_power value changed, or reportedStepId
     * changed). Consumers are responsible for their own eligibility checks.
     */
    onSnapshotMutated?: (snapshot: TargetDeviceSnapshot, nowMs: number) => void;
    /**
     * Observer-owned dispatcher consulted by transport after translation of
     * each realtime event. Wiring (`setup/`) builds the dispatcher against
     * `lib/observer/observedStateEvents.ts`'s `ObservedStateEmitter`. When
     * supplied, observer is the single source of truth for the post-translation
     * fan-out and transport does not emit through its own EventEmitter.
     *
     * When omitted (legacy direct-`DeviceTransport` tests), transport falls
     * back to emitting `PLAN_LIVE_STATE_OBSERVED_EVENT` and
     * `OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT` through its own EventEmitter so
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
// Re-exported from its owner beside the `LivePowerReport` type, so adding a
// field cannot leave a second construction site behind.
export { buildEmptyLivePowerReport } from './managerFetch';

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
        if (device.temperature !== undefined) temperatureKnownDevices++;
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
