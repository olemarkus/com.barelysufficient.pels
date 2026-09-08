import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { PlanEngineState } from './planState';
import { incPerfCounter } from '../utils/perfCounters';
import {
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  clearSurplusEligibility,
  clearSurplusTracking,
  closeActivationAttemptForDevice,
  isActivationObservationActiveNow,
  syncActivationPenaltyState,
} from './admission';
import type {
  DeviceDiagnosticsBackoffTransition,
  DeviceDiagnosticsRecorder,
  DeviceDiagnosticsTrackedTransitionReconciliation,
} from '../diagnostics/deviceDiagnosticsService';
import {
  ensureHeadroomEntry,
  isFiniteNumber,
  resolveTrackedTransitionReconciliation,
  type HeadroomCardDeviceLike,
  type HeadroomCooldownCandidate,
} from './planHeadroomSupport';

const HEADROOM_STEP_DOWN_THRESHOLD_KW = 0.15;

const removeHeadroomCardStateForDevice = (
  state: PlanEngineState,
  deviceId: string,
): void => {
  const cards = state.headroomCardByDevice;
  const entry = cards[deviceId];
  if (!entry) return;
  delete entry.lastUsageKw;
  delete entry.lastStepDownMs;
  if (Object.keys(entry).length === 0) {
    delete cards[deviceId];
  }
};

const collectTrackedDeviceIds = (state: PlanEngineState): Set<string> => (
  new Set([
    ...Object.keys(state.headroomCardByDevice),
    ...Object.keys(state.surplusEligibilityByDevice),
    ...Object.keys(state.surplusTrackingByDevice),
  ])
);

const cleanupMissingHeadroomDevices = (
  state: PlanEngineState,
  devices: HeadroomCardDeviceLike[],
): boolean => {
  let stateChanged = false;
  const activeIds = new Set(devices.map((device) => device.id));
  const trackedIds = collectTrackedDeviceIds(state);
  for (const deviceId of trackedIds) {
    if (activeIds.has(deviceId)) continue;
    removeHeadroomCardStateForDevice(state, deviceId);
    // Drop surplus-absorb eligibility for a device that left the snapshot, in
    // lockstep with the other per-device plan maps (it self-cleans while a device
    // keeps cycling, but an unpaired-while-eligible device would otherwise leak).
    clearSurplusEligibility(state, deviceId);
    // Same lockstep for the tracking decision: a rung left behind by a departed
    // device would clamp it the moment it reappeared, before the allocator had
    // seen a single reading for it.
    clearSurplusTracking(state, deviceId);
    // A missing snapshot should close any open attempt, but it must not forgive prior failed activations.
    closeActivationAttemptForDevice(state, deviceId);
    stateChanged = true;
  }
  return stateChanged;
};

const wasRecentlySteppedDown = (
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): boolean => {
  const lastStepDownMs = state.headroomCardByDevice[deviceId]?.lastStepDownMs;
  if (!isFiniteNumber(lastStepDownMs)) return false;
  return nowTs - lastStepDownMs < ACTIVATION_BACKOFF_CLEAR_WINDOW_MS;
};

export const emitActivationTransition = (
  diagnostics: DeviceDiagnosticsRecorder | undefined,
  deviceName: string,
  transition: DeviceDiagnosticsBackoffTransition | null,
): void => {
  if (!diagnostics || !transition) return;
  diagnostics.recordActivationTransition(transition, { name: deviceName });
};

// A tracked rise is worth a diagnostics event when a device PELS is not
// currently activating went from (near) idle — or from a recent step-down — to
// drawing. Reconciliation and tracked usage changes are useful diagnostics, but
// they are not proof that PELS restored the device and must not create
// restore-blocking penalty state; this records nothing on the plan state.
const isReportableTrackedRise = (
  state: PlanEngineState,
  device: HeadroomCardDeviceLike,
  previousUsageKw: number,
  nowTs: number,
  attemptOpen: boolean,
): boolean => {
  if (device.currentDrawKw - previousUsageKw < HEADROOM_STEP_DOWN_THRESHOLD_KW) return false;
  if (attemptOpen) return false;
  if (!isActivationObservationActiveNow(device)) return false;
  if (previousUsageKw <= HEADROOM_STEP_DOWN_THRESHOLD_KW) return true;
  return wasRecentlySteppedDown(state, device.id, nowTs);
};

/**
 * Fold one usage reading into a device's headroom-card entry. The draw alone
 * decides: an unchanged value is a no-op, a changed one is news. (This used to
 * compare the incoming observation's timestamp against the stored one and drop
 * an older or unstamped reading — the planner second-guessing the order the
 * observer handed it values in, which the root `AGENTS.md` forbids.)
 *
 * A step-down of at least the threshold stamps `lastStepDownMs` — the one thing
 * here that changes what a later plan reads. Tracked power changes are useful
 * for diagnostics, but restore failure/backoff belongs to explicit planner
 * signals such as a plan rebuild's actuation or overshoot attribution: a normal
 * device duty cycle must not become `setback_failed` here.
 */
const syncTrackedUsage = (
  state: PlanEngineState,
  device: HeadroomCardDeviceLike,
  nowTs: number,
  attemptOpen: boolean,
  reconciliation: DeviceDiagnosticsTrackedTransitionReconciliation | undefined,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
): boolean => {
  const usageKw = device.currentDrawKw;
  const previousUsageKw = state.headroomCardByDevice[device.id]?.lastUsageKw;
  if (previousUsageKw === usageKw) {
    incPerfCounter('tracked_usage_update_skipped_noop');
    return false;
  }
  const entry = ensureHeadroomEntry(state, device.id);
  entry.lastUsageKw = usageKw;
  entry.deviceName = device.name;
  if (previousUsageKw === undefined) return false;

  const dropped = previousUsageKw - usageKw >= HEADROOM_STEP_DOWN_THRESHOLD_KW;
  if (dropped) entry.lastStepDownMs = nowTs;
  // A rise and a drop of the threshold cannot both hold, so one sync reports at most one.
  const rose = !dropped && isReportableTrackedRise(state, device, previousUsageKw, nowTs, attemptOpen);
  if (diagnostics && (dropped || rose)) {
    diagnostics.recordControlEvent({
      kind: dropped ? 'tracked_usage_drop' : 'tracked_usage_rise',
      deviceId: device.id,
      name: device.name,
      nowTs,
      fromKw: previousUsageKw,
      toKw: usageKw,
      reconciliation: reconciliation ?? resolveTrackedTransitionReconciliation(state, device.id, nowTs),
    });
  }
  return dropped;
};

const syncHeadroomCardDevice = (
  state: PlanEngineState,
  device: HeadroomCardDeviceLike,
  nowTs: number,
  reconciliation: DeviceDiagnosticsTrackedTransitionReconciliation | undefined,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
): boolean => {
  // Every build syncs the penalty, unconditionally. This used to be gated on the
  // incoming observation's timestamp being no older than the stored one — the
  // planner deciding an observation was not worth acting on, which is the
  // observer's call and not its own. The observer publishes the trusted current
  // value; there is no stamp here to weigh it by.
  const penaltyInfo = syncActivationPenaltyState(state, device.id, nowTs, device);
  emitActivationTransition(diagnostics, device.name, penaltyInfo.transition);
  const usageStateChanged = syncTrackedUsage(
    state, device, nowTs, penaltyInfo.attemptOpen, reconciliation, diagnostics,
  );
  return penaltyInfo.stateChanged || usageStateChanged;
};

/** Sync the devices a plan build just planned. Not every device is here, so nothing is cleaned up. */
export const syncHeadroomCardState = (
  state: PlanEngineState,
  devices: HeadroomCardDeviceLike[],
  nowTs: number,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
): boolean => {
  let stateChanged = false;
  for (const device of devices) {
    if (syncHeadroomCardDevice(state, device, nowTs, undefined, diagnostics)) stateChanged = true;
  }
  return stateChanged;
};

/**
 * Sync a COMPLETE device snapshot: a device missing from it has left the home,
 * so the per-device tracking it left behind goes too. `reconciliation` is the
 * label the caller knows its tracked usage changes happened under (the snapshot
 * refresh stamps `snapshot_refresh`); without one it is read off the plan state.
 */
export const syncHeadroomCardSnapshot = (
  state: PlanEngineState,
  snapshot: HeadroomCardDeviceLike[],
  nowTs: number,
  reconciliation: DeviceDiagnosticsTrackedTransitionReconciliation | undefined,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
): boolean => {
  let stateChanged = cleanupMissingHeadroomDevices(state, snapshot);
  for (const device of snapshot) {
    if (syncHeadroomCardDevice(state, device, nowTs, reconciliation, diagnostics)) stateChanged = true;
  }
  return stateChanged;
};

/**
 * The owner wrote a device's expected-power figure: fold it in as that device's
 * usage. No device is at hand here, so the entry keeps whatever name it had and
 * no rise is reported; a drop still stamps `lastStepDownMs`.
 */
export const syncHeadroomUsageObservation = (
  state: PlanEngineState,
  deviceId: string,
  usageKw: number,
  nowTs: number,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
): boolean => {
  const previousUsageKw = state.headroomCardByDevice[deviceId]?.lastUsageKw;
  if (previousUsageKw === usageKw) {
    incPerfCounter('tracked_usage_update_skipped_noop');
    return false;
  }
  const entry = ensureHeadroomEntry(state, deviceId);
  entry.lastUsageKw = usageKw;
  if (previousUsageKw === undefined || previousUsageKw - usageKw < HEADROOM_STEP_DOWN_THRESHOLD_KW) return false;
  entry.lastStepDownMs = nowTs;
  if (diagnostics && entry.deviceName) {
    diagnostics.recordControlEvent({
      kind: 'tracked_usage_drop',
      deviceId,
      name: entry.deviceName,
      nowTs,
      fromKw: previousUsageKw,
      toKw: usageKw,
      reconciliation: resolveTrackedTransitionReconciliation(state, deviceId, nowTs),
    });
  }
  return true;
};

export const resolveHeadroomCardCooldown = (
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): HeadroomCooldownCandidate | null => {
  const rawLastShedMs = state.actuation.lastDeviceShedMs[deviceId];
  const rawLastRestoreMs = state.actuation.lastDeviceRestoreMs[deviceId];
  const lastShedMs = isFiniteNumber(rawLastShedMs) ? rawLastShedMs : null;
  const lastRestoreMs = isFiniteNumber(rawLastRestoreMs) ? rawLastRestoreMs : null;
  const shedExpiresAtMs = lastShedMs === null ? null : lastShedMs + SHED_COOLDOWN_MS;
  const restoreExpiresAtMs = lastRestoreMs === null ? null : lastRestoreMs + RESTORE_COOLDOWN_MS;

  const candidates: HeadroomCooldownCandidate[] = [];
  if (lastShedMs !== null && isFiniteNumber(shedExpiresAtMs) && shedExpiresAtMs > nowTs) {
    candidates.push({
      source: 'pels_shed',
      remainingSec: Math.max(0, Math.ceil((shedExpiresAtMs - nowTs) / 1000)),
      expiresAtMs: shedExpiresAtMs,
      startMs: lastShedMs,
      totalSec: Math.ceil(SHED_COOLDOWN_MS / 1000),
      dropFromKw: null,
      dropToKw: null,
    });
  }
  if (lastRestoreMs !== null && isFiniteNumber(restoreExpiresAtMs) && restoreExpiresAtMs > nowTs) {
    candidates.push({
      source: 'pels_restore',
      remainingSec: Math.max(0, Math.ceil((restoreExpiresAtMs - nowTs) / 1000)),
      expiresAtMs: restoreExpiresAtMs,
      startMs: lastRestoreMs,
      totalSec: Math.ceil(RESTORE_COOLDOWN_MS / 1000),
      dropFromKw: null,
      dropToKw: null,
    });
  }
  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    if (left.expiresAtMs !== right.expiresAtMs) return right.expiresAtMs - left.expiresAtMs;
    if (left.startMs !== right.startMs) return right.startMs - left.startMs;
    if (left.source === right.source) return 0;
    if (left.source === 'pels_restore') return -1;
    if (right.source === 'pels_restore') return 1;
    return 0;
  });
  return candidates[0] ?? null;
};
