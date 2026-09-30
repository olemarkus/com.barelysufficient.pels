/**
 * Native stepped-load realtime handling: translates a `target_power` /
 * stepped-load / `available_installation_current` capability change into a
 * reported-step update on the held snapshot and the matching observed-state /
 * observed-control-state dispatches. Split out of `realtimeCapabilityHandling` to keep
 * each module under the line ceiling.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { TargetPowerSteppedLoadPreset } from '../../../packages/contracts/src/types';
import { getLogger } from '../../logging/logger';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { recordCapabilityObservation } from './managerObservation';
import {
  observeNativeSteppedLoadCapabilityUpdate,
  resolveObservedNativeSteppedLoadReportedStepId,
} from '../managerNativeSteppedCommand';
import {
  AVAILABLE_INSTALLATION_CURRENT_CAPABILITY_ID,
  EASEE_CHARGER_CURRENT_CAPABILITY_ID,
  EASEE_MIN_CHARGING_CURRENT_A,
  isNativeSteppedLoadControlCapabilityId,
  isNativeSteppedLoadControlEnabled,
  resolveNativeSteppedLoadReportedStepId,
  resolveTargetPowerReportedStepId,
} from '../nativeSteppedLoadWiring';
import { isEvTargetPowerConfig, resolveEvTargetPowerExactStep } from '../targetPowerReachability';
import { resolveTargetPowerObservationProfile } from '../targetPowerObservationProfile';
import { PELS_MEASURE_STEP_CAPABILITY_ID } from '../../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { resolveTargetPowerPresetPhaseCount } from '../../../packages/shared-domain/src/targetPowerStepping';
import {
  emitCapabilityEventReceived,
  hasMatchingRecentLocalWrite,
  normalizeRealtimeCapabilityEventValue,
} from './realtimeCapabilityShared';
import type { RealtimeIngestService } from './transportServices';

const moduleLogger = getLogger('device/transport');

function resolveNativeSteppedCapabilityUpdateKind(params: {
    capabilityId: string;
    value: unknown;
    snapshot: TransportDeviceSnapshot;
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
    const isNativeBinaryUpdate = capabilityId === snapshot.binaryCapabilityId && typeof value === 'boolean';
    if (!isNativePowerStepUpdate && !isNativeBinaryUpdate) {
        return null;
    }
    return {
        isNativePowerStepUpdate,
    };
}

function emitNativeSteppedLoadReportedStepChanged(ingest: RealtimeIngestService, params: {
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
    emitCapabilityEventReceived(
        ingest.observationBridge.state,
        deviceId,
        PELS_MEASURE_STEP_CAPABILITY_ID,
        nextReportedStepId ?? 'unknown',
    );
    const cursor = ingest.observationBridge.nextCursor(deviceId);
    moduleLogger.info({
        event: 'realtime_capability_drift',
        deviceId,
        capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        changes: [change],
    });
    ingest.observationBridge.dispatchStateChanged({
        source: 'realtime_capability',
        deviceId,
        ...cursor,
        capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    });
    ingest.observationBridge.dispatchControlStateChanged({
        deviceId,
        ...cursor,
        name: deviceName,
        changes: [change],
    });
}

// Transport owns the held snapshot and updates it before dispatch through the observer bridge.
/* eslint-disable functional/immutable-data */
function applyNativeSteppedLoadSnapshotUpdate(ingest: RealtimeIngestService, params: {
    snapshotIndex: number;
    deviceId: string;
    capabilityId: string;
    nextReportedStepId: string | undefined;
    isNativePowerStepUpdate: boolean;
    reportedStepPowerW?: number;
    reportedStepObservedAtMs?: number;
}): void {
    const {
        snapshotIndex,
        deviceId,
        capabilityId,
        nextReportedStepId,
        isNativePowerStepUpdate,
        reportedStepPowerW,
        reportedStepObservedAtMs,
    } = params;
    const currentSnapshot = ingest.reader.snapshotStore.getSnapshot()[snapshotIndex];
    // The index was resolved against this same snapshot array by the caller, so a miss
    // cannot happen; there is nothing to update if it ever did.
    if (currentSnapshot === undefined) return;
    const previousReportedStepId = currentSnapshot.reportedStepId;
    const previousReportedStepPowerW = currentSnapshot.reportedStepPowerW;
    const previousReportedStepObservedAtMs = currentSnapshot.reportedStepObservedAtMs;
    if (nextReportedStepId) currentSnapshot.reportedStepId = nextReportedStepId;
    else delete currentSnapshot.reportedStepId;
    if (reportedStepPowerW !== undefined) currentSnapshot.reportedStepPowerW = reportedStepPowerW;
    if (reportedStepObservedAtMs !== undefined) {
        currentSnapshot.reportedStepObservedAtMs = reportedStepObservedAtMs;
    }
    if (isNativePowerStepUpdate) {
        currentSnapshot.lastFreshDataMs = Date.now();
        currentSnapshot.lastUpdated = currentSnapshot.lastFreshDataMs;
    }
    ingest.publishDeviceConfiguration(deviceId);
    const reportedStepChanged = previousReportedStepId !== nextReportedStepId;
    if (reportedStepChanged) {
        emitNativeSteppedLoadReportedStepChanged(ingest, {
            deviceId,
            deviceName: currentSnapshot.name,
            previousReportedStepId,
            nextReportedStepId,
        });
    }
    const exactPowerObservationChanged = isNativePowerStepUpdate && (
        previousReportedStepPowerW !== reportedStepPowerW
        || previousReportedStepObservedAtMs !== reportedStepObservedAtMs
    );
    if (reportedStepChanged || exactPowerObservationChanged) {
        ingest.notifications.snapshotChanged(currentSnapshot, Date.now());
    }
    // A power-step that does NOT change the reported step still advances
    // lastFreshDataMs/lastUpdated in place but skips the dispatch funnel (the
    // reportedStepChanged branch above is the only one that dispatches). Push
    // the freshness delta ourselves so the observer projection doesn't lag the
    // snapshot until the next full refresh — a projection-fed freshness reader
    // (stage 4b) would otherwise see the device as stale. When the reported
    // step changed, emitNativeSteppedLoadReportedStepChanged already dispatched
    // the (freshness-inclusive) delta, so this guards against a double push.
    if (isNativePowerStepUpdate && !reportedStepChanged) {
        ingest.observationBridge.dispatchStateChanged({
            source: 'realtime_capability',
            deviceId,
            ...ingest.observationBridge.nextCursor(deviceId),
            capabilityId,
        });
    }
}
/* eslint-enable functional/immutable-data */

/**
 * Watts per unit of a native EV step observation, for the preset's
 * reachability evidence: `target_power` already is watts; an Easee charger
 * current is amps, converted through the preset's phase count as the
 * installation-current report is.
 */
function resolveEvStepObservationWattsPerUnit(capabilityId: string, preset: TargetPowerSteppedLoadPreset): number {
    if (capabilityId === 'target_power') return 1;
    return 230 * (preset === 'ev_charger_3_phase' ? 3 : 1);
}

// The exact watts a native EV step observation carries. Only an EV preset's
// own step capabilities carry one; everything else leaves the snapshot's
// exact power as it is.
function resolveNativeReportedStepPowerW(
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): TransportDeviceSnapshot['reportedStepPowerW'] {
    if (capabilityId !== 'target_power' && capabilityId !== EASEE_CHARGER_CURRENT_CAPABILITY_ID) return undefined;
    if (!isEvTargetPowerConfig(snapshot.targetPowerConfig)) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (capabilityId === EASEE_CHARGER_CURRENT_CAPABILITY_ID && value < EASEE_MIN_CHARGING_CURRENT_A) return 0;
    return Math.round(value * resolveEvStepObservationWattsPerUnit(capabilityId, snapshot.targetPowerConfig.preset));
}

export function handleNativeSteppedLoadCapabilityUpdate(ingest: RealtimeIngestService, params: {
    snapshotIndex: number;
    deviceId: string;
    capabilityId: string;
    value: unknown;
    snapshot: TransportDeviceSnapshot;
}): boolean {
    const {
        snapshotIndex,
        deviceId,
        capabilityId,
        value,
        snapshot,
    } = params;
    if (!isNativeSteppedLoadControlEnabled(snapshot)) return false;
    const profile = snapshot.steppedLoadProfile;
    if (!profile) return false;

    const updateKind = resolveNativeSteppedCapabilityUpdateKind({
        capabilityId,
        value,
        snapshot,
    });
    if (!updateKind) return false;
    const { isNativePowerStepUpdate } = updateKind;

    // A malformed current is not an observation. Consume it before it can
    // replace the adapter's last-good step or advance device freshness.
    if (isInvalidEaseeCurrent(capabilityId, value)) return true;

    const normalizedValue = normalizeRealtimeCapabilityEventValue(capabilityId, value);
    // An Easee current echo is also the only source for its reported rung and
    // derived charging switch. Let the adapter consume it even though it echoes
    // PELS's write; suppressing it leaves the prior rung cached until refresh.
    if (shouldSuppressOwnNativeStepEcho(ingest, deviceId, capabilityId, normalizedValue)) {
        return isNativePowerStepUpdate;
    }

    const reportedStepPowerW = resolveNativeReportedStepPowerW(snapshot, capabilityId, value);
    if (reportedStepPowerW !== undefined
        && !acceptExactTargetPowerObservation(snapshot, reportedStepPowerW)) return true;

    if (capabilityId === 'target_power' || capabilityId === EASEE_CHARGER_CURRENT_CAPABILITY_ID) {
        recordCapabilityObservation({
            state: ingest.observationBridge.state.getObservationState(),
            latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
            deviceId,
            capabilityId,
            value: normalizedValue,
            source: 'realtime_capability',
            countsTowardDeviceFreshness: true,
        });
    }

    observeNativeSteppedLoadCapabilityUpdate({
        owner: ingest.reader.snapshotStore,
        deviceId,
        capabilityId,
        value,
        logger: ingest.reader.logger,
    });

    const fallbackReportedStepId = value === false
        ? resolveNativeSteppedLoadReportedStepId({
            profile,
            capabilities: [],
            capabilityObj: {
                onoff: { value: false },
            },
        })
        : undefined;
    const nextReportedStepId = resolveObservedNativeSteppedLoadReportedStepId({
        owner: ingest.reader.snapshotStore,
        deviceId,
        profile: snapshot.steppedLoadProfile ?? profile,
    }) ?? fallbackReportedStepId;

    applyNativeSteppedLoadSnapshotUpdate(ingest, {
        snapshotIndex,
        deviceId,
        capabilityId,
        nextReportedStepId,
        isNativePowerStepUpdate,
        reportedStepPowerW,
        ...(isNativePowerStepUpdate ? { reportedStepObservedAtMs: Date.now() } : {}),
    });
    return isNativePowerStepUpdate;
}

function isInvalidEaseeCurrent(capabilityId: string, value: unknown): boolean {
    return capabilityId === EASEE_CHARGER_CURRENT_CAPABILITY_ID
        && (typeof value !== 'number' || !Number.isFinite(value) || value < 0);
}

function shouldSuppressOwnNativeStepEcho(
    ingest: RealtimeIngestService,
    deviceId: string,
    capabilityId: string,
    normalizedValue: unknown,
): boolean {
    return capabilityId !== EASEE_CHARGER_CURRENT_CAPABILITY_ID
        && hasMatchingRecentLocalWrite(ingest.observationBridge.state, deviceId, capabilityId, normalizedValue);
}

export function handleTargetPowerSourceCapabilityUpdate(ingest: RealtimeIngestService, params: {
    snapshotIndex: number;
    deviceId: string;
    capabilityId: string;
    value: unknown;
    // Owner seam reading the transport's own snapshot: `TransportDeviceSnapshot`
    // carries `targetPowerConfig` / `steppedLoadProfile` via the descriptor probe
    // (omitted from the base `TargetDeviceSnapshot`).
    snapshot: TransportDeviceSnapshot;
}): boolean {
    const {
        snapshotIndex,
        deviceId,
        capabilityId,
        value,
        snapshot,
    } = params;
    if (capabilityId !== AVAILABLE_INSTALLATION_CURRENT_CAPABILITY_ID) return false;
    if (isNativeSteppedLoadControlEnabled(snapshot)
        && snapshot.capabilities?.includes(EASEE_CHARGER_CURRENT_CAPABILITY_ID)) return true;
    const phaseCount = resolveTargetPowerPresetPhaseCount(snapshot.targetPowerConfig?.preset);
    if (!phaseCount || typeof value !== 'number' || !Number.isFinite(value)) return false;
    const profile = snapshot.steppedLoadProfile;
    if (!profile) return false;
    const targetPowerW = Math.round(value * 230 * phaseCount);
    if (!acceptExactTargetPowerObservation(snapshot, targetPowerW)) return true;
    const nextReportedStepId = resolveTargetPowerReportedStepId({
        profile: snapshot.steppedLoadProfile ?? profile,
        capabilityObj: {
            target_power: { value: targetPowerW },
        },
    });
    recordCapabilityObservation({
        state: ingest.observationBridge.state.getObservationState(),
        latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
        deviceId,
        capabilityId,
        value,
        source: 'realtime_capability',
        countsTowardDeviceFreshness: true,
    });
    applyNativeSteppedLoadSnapshotUpdate(ingest, {
        snapshotIndex,
        deviceId,
        capabilityId,
        nextReportedStepId,
        isNativePowerStepUpdate: true,
        reportedStepPowerW: targetPowerW,
        reportedStepObservedAtMs: Date.now(),
    });
    return true;
}

/** Admit the native source before updating the confirmed EV ladder. */
/* eslint-disable functional/immutable-data -- This source owns the transport snapshot. */
function acceptExactTargetPowerObservation(snapshot: TransportDeviceSnapshot, planningPowerW: number): boolean {
    if (!isEvTargetPowerConfig(snapshot.targetPowerConfig)) return true;
    const exactStep = resolveEvTargetPowerExactStep(snapshot.targetPowerConfig, planningPowerW);
    if (!exactStep || !snapshot.steppedLoadProfile) return false;
    const admittedSnapshot = snapshot;
    admittedSnapshot.steppedLoadProfile = resolveTargetPowerObservationProfile(
        snapshot.targetPowerConfig, snapshot.steppedLoadProfile, exactStep,
    );
    return true;
}
/* eslint-enable functional/immutable-data */
