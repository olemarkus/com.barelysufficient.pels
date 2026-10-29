import { getCapabilityAdapter, getSnapshotAdapter } from '../deviceAdapterRegistry';
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
import {
  AVAILABLE_INSTALLATION_CURRENT_CAPABILITY_ID,
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
  dispatchRealtimeObservation,
  emitCapabilityEventReceived,
  hasMatchingRecentLocalWrite,
  normalizeRealtimeCapabilityEventValue,
  recordRealtimeObservation,
} from './realtimeCapabilityShared';
import type { RealtimeIngestService } from './transportServices';

const moduleLogger = getLogger('device/transport');

/** Whether this update is a native power step (true), a native binary report (false), or neither (null). */
function resolveNativePowerStepUpdate(
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): boolean | null {
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
    if (!isNativePowerStepUpdate && !isNativeBinaryUpdate) return null;
    return isNativePowerStepUpdate;
}

function emitNativeSteppedLoadReportedStepChanged(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    previousReportedStepId: string | undefined,
    nextReportedStepId: string | undefined,
): void {
    const { id: deviceId, name: deviceName } = snapshot;
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
    moduleLogger.info({
        event: 'native_stepped_load_report_changed',
        deviceId,
        deviceName,
        capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        previousReportedStepId: previousReportedStepId ?? null,
        reportedStepId: nextReportedStepId ?? null,
        changes: [change],
    });
    const cursor = dispatchRealtimeObservation(ingest, deviceId, PELS_MEASURE_STEP_CAPABILITY_ID);
    ingest.observationBridge.dispatchControlStateChanged({
        deviceId,
        ...cursor,
        name: deviceName,
        changes: [change],
    });
}

// Transport owns the held snapshot and updates it before dispatch through the observer bridge.
/* eslint-disable functional/immutable-data, no-param-reassign */
/**
 * Apply a native step report to the held snapshot. A power-step report carries
 * the exact watts it reported (`reportedStepPowerW`, absent when the report has
 * no exact power) and is stamped observed now; a binary report only moves the
 * reported step.
 */
function applyNativeSteppedLoadSnapshotUpdate(
    ingest: RealtimeIngestService,
    currentSnapshot: TransportDeviceSnapshot,
    capabilityId: string,
    nextReportedStepId: string | undefined,
    isNativePowerStepUpdate: boolean,
    reportedStepPowerW: number | undefined,
): void {
    const deviceId = currentSnapshot.id;
    const reportedStepObservedAtMs = isNativePowerStepUpdate ? Date.now() : undefined;
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
        emitNativeSteppedLoadReportedStepChanged(ingest, currentSnapshot, previousReportedStepId, nextReportedStepId);
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
        dispatchRealtimeObservation(ingest, deviceId, capabilityId);
    }
}
/* eslint-enable functional/immutable-data, no-param-reassign */

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
    const current = getCapabilityAdapter([capabilityId]).nativeCurrentControls
      .find((control) => control.capabilityId === capabilityId);
    if (capabilityId !== 'target_power' && !current) return undefined;
    if (!isEvTargetPowerConfig(snapshot.targetPowerConfig)) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (current && value < current.minimumChargingA) return 0;
    return Math.round(value * resolveEvStepObservationWattsPerUnit(capabilityId, snapshot.targetPowerConfig.preset));
}

export function handleNativeSteppedLoadCapabilityUpdate(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): boolean {
    const deviceId = snapshot.id;
    if (!isNativeSteppedLoadControlEnabled(snapshot)) return false;
    const profile = snapshot.steppedLoadProfile;
    if (!profile) return false;

    const isNativePowerStepUpdate = resolveNativePowerStepUpdate(snapshot, capabilityId, value);
    if (isNativePowerStepUpdate === null) return false;

    // A malformed current is not an observation. Consume it before it can
    // replace the adapter's last-good step or advance device freshness.
    if (isInvalidNativeCurrent(capabilityId, value)) return true;

    const normalizedValue = normalizeRealtimeCapabilityEventValue(capabilityId, value);
    // An Easee current echo is also the only source for its reported rung and
    // derived charging switch. Let the adapter consume it even though it echoes
    // PELS's write; suppressing it leaves the prior rung cached until refresh.
    if (shouldSuppressOwnNativeStepEcho(ingest, deviceId, capabilityId, normalizedValue)) {
        return isNativePowerStepUpdate;
    }

    const reportedStepPowerW = resolveNativeReportedStepPowerW(snapshot, capabilityId, value);
    // A negative watt reading is malformed, not an off-range setting: consume it
    // before it can be recorded as probe evidence or replace the last-good step.
    if (reportedStepPowerW !== undefined && reportedStepPowerW < 0) return true;
    if (reportedStepPowerW !== undefined) extendLadderWithExactTargetPower(snapshot, reportedStepPowerW);

    if (capabilityId === 'target_power' || getCapabilityAdapter([capabilityId]).nativeCurrentControls
      .some((control) => control.capabilityId === capabilityId)) {
        recordRealtimeObservation(ingest, deviceId, capabilityId, normalizedValue, true);
    }

    const adapters = ingest.reader.snapshotStore.nativeSteppedAdapters;
    adapters.observeCapabilityUpdate(deviceId, capabilityId, value);

    const fallbackReportedStepId = value === false
        ? resolveNativeSteppedLoadReportedStepId({
            profile,
            capabilities: [],
            capabilityObj: {
                onoff: { value: false },
            },
        })
        : undefined;
    const nextReportedStepId = adapters.getReportedStepId(deviceId, snapshot.steppedLoadProfile ?? profile)
        ?? fallbackReportedStepId;

    applyNativeSteppedLoadSnapshotUpdate(
        ingest, snapshot, capabilityId, nextReportedStepId, isNativePowerStepUpdate, reportedStepPowerW,
    );
    return isNativePowerStepUpdate;
}

function isInvalidNativeCurrent(capabilityId: string, value: unknown): boolean {
    return getCapabilityAdapter([capabilityId]).nativeCurrentControls
      .some((control) => control.capabilityId === capabilityId)
        && (typeof value !== 'number' || !Number.isFinite(value) || value < 0);
}

function shouldSuppressOwnNativeStepEcho(
    ingest: RealtimeIngestService,
    deviceId: string,
    capabilityId: string,
    normalizedValue: unknown,
): boolean {
    return !getCapabilityAdapter([capabilityId]).nativeCurrentControls
      .some((control) => control.capabilityId === capabilityId)
        && hasMatchingRecentLocalWrite(ingest.observationBridge.state, deviceId, capabilityId, normalizedValue);
}

export function handleTargetPowerSourceCapabilityUpdate(
    ingest: RealtimeIngestService,
    // Owner seam reading the transport's own snapshot: `TransportDeviceSnapshot`
    // carries `targetPowerConfig` / `steppedLoadProfile` via the descriptor probe
    // (omitted from the base `TargetDeviceSnapshot`).
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): boolean {
    if (capabilityId !== AVAILABLE_INSTALLATION_CURRENT_CAPABILITY_ID) return false;
    if (isNativeSteppedLoadControlEnabled(snapshot)
        && getSnapshotAdapter(snapshot).nativeCurrentControls.length > 0) return true;
    const phaseCount = resolveTargetPowerPresetPhaseCount(snapshot.targetPowerConfig?.preset);
    if (!phaseCount || typeof value !== 'number' || !Number.isFinite(value)) return false;
    const profile = snapshot.steppedLoadProfile;
    if (!profile) return false;
    const targetPowerW = Math.round(value * 230 * phaseCount);
    if (targetPowerW < 0) return true;
    extendLadderWithExactTargetPower(snapshot, targetPowerW);
    const nextReportedStepId = resolveTargetPowerReportedStepId({
        profile: snapshot.steppedLoadProfile ?? profile,
        capabilityObj: {
            target_power: { value: targetPowerW },
        },
    });
    recordRealtimeObservation(ingest, snapshot.id, capabilityId, value, true);
    applyNativeSteppedLoadSnapshotUpdate(ingest, snapshot, capabilityId, nextReportedStepId, true, targetPowerW);
    return true;
}

/**
 * An exact EV reading inside the preset range extends the confirmed ladder with
 * its step. A reading outside it (a vendor-app change, a reboot back to 32 A) is
 * still the device's state: the caller applies its nearest rung, but it never
 * widens the ladder. Reachability ignores watts outside the preset on its own.
 */
/* eslint-disable functional/immutable-data -- This source owns the transport snapshot. */
function extendLadderWithExactTargetPower(snapshot: TransportDeviceSnapshot, planningPowerW: number): void {
    if (!isEvTargetPowerConfig(snapshot.targetPowerConfig) || !snapshot.steppedLoadProfile) return;
    const exactStep = resolveEvTargetPowerExactStep(snapshot.targetPowerConfig, planningPowerW);
    if (!exactStep) return;
    const admittedSnapshot = snapshot;
    admittedSnapshot.steppedLoadProfile = resolveTargetPowerObservationProfile(
        snapshot.targetPowerConfig, snapshot.steppedLoadProfile, exactStep,
    );
}
/* eslint-enable functional/immutable-data */
