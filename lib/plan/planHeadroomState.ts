import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { PlanEngineState } from './planState';
import { incPerfCounter } from '../utils/perfCounters';
import {
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  closeActivationAttemptForDevice,
  isActivationObservationActiveNow,
  syncActivationPenaltyState,
} from './planActivationBackoff';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  ensureHeadroomEntry,
  isFiniteNumber,
  resolveTrackedUsageMergeDecision,
  resolveTrackedTransitionReconciliation,
  resolveHeadroomDeviceName,
  resolveTrackedHeadroomDeviceKw,
  updateHeadroomCardLastObserved,
  type HeadroomCardDeviceLike,
  type HeadroomCooldownCandidate,
  type HeadroomDeviceKwSource,
  type HeadroomTrackedTransitionContext,
} from './planHeadroomSupport';

const HEADROOM_STEP_DOWN_THRESHOLD_KW = 0.15;

const removeHeadroomCardStateForDevice = (
  state: PlanEngineState,
  deviceId: string,
  options: { keepLastObserved?: boolean } = {},
): void => {
  const cards = state.headroomCardByDevice;
  const entry = cards[deviceId];
  if (!entry) return;
  if (!options.keepLastObserved) {
    delete entry.lastObservedKw;
    delete entry.lastObservedKwSource;
  }
  delete entry.lastStepDownMs;
  if (Object.keys(entry).length === 0) {
    delete cards[deviceId];
  }
};

const collectTrackedDeviceIds = (state: PlanEngineState): Set<string> => (
  new Set(Object.keys(state.headroomCardByDevice))
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
    // A missing snapshot should close any open attempt, but it must not forgive prior failed activations.
    stateChanged = closeActivationAttemptForDevice(state, deviceId) || true;
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

const shouldStartTrackedActivationAttempt = (params: {
  state: PlanEngineState;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  attemptOpen: boolean;
}): boolean => {
  const {
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    attemptOpen,
  } = params;
  if (trackedKw - previousTrackedKw < HEADROOM_STEP_DOWN_THRESHOLD_KW) return false;
  if (attemptOpen) return false;
  if (!isActivationObservationActiveNow(device)) return false;
  if (previousTrackedKw <= HEADROOM_STEP_DOWN_THRESHOLD_KW) return true;
  return wasRecentlySteppedDown(state, deviceId, nowTs);
};

export const emitActivationTransitions = (
  diagnostics: DeviceDiagnosticsRecorder | undefined,
  deviceName: string | undefined,
  transitions: Array<Parameters<DeviceDiagnosticsRecorder['recordActivationTransition']>[0]>,
): void => {
  if (!diagnostics || transitions.length === 0) return;
  for (const transition of transitions) {
    diagnostics.recordActivationTransition(transition, { name: deviceName });
  }
};

const maybeStartTrackedActivationAttempt = (params: {
  state: PlanEngineState;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  deviceName?: string;
  attemptOpen: boolean;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    deviceName,
    attemptOpen,
    reconciliationContext,
    diagnostics,
  } = params;
  if (!shouldStartTrackedActivationAttempt({
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    attemptOpen,
  })) {
    return false;
  }

  const name = resolveHeadroomDeviceName({ state, deviceId, device, deviceName });
  if (name) {
    // Reconciliation and tracked usage changes are useful diagnostics, but they are not proof
    // that PELS restored the device and should not create restore-blocking penalty state.
    const reconciliation = resolveTrackedTransitionReconciliation({
      state,
      deviceId,
      nowTs,
      context: reconciliationContext,
    });
    diagnostics?.recordControlEvent({
      kind: 'tracked_usage_rise',
      deviceId,
      name,
      nowTs,
      fromKw: previousTrackedKw,
      toKw: trackedKw,
      reconciliation,
    });
  }
  return false;
};

const maybeRecordTrackedStepDown = (params: {
  state: PlanEngineState;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  deviceName?: string;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    deviceName,
    reconciliationContext,
    diagnostics,
  } = params;
  if (previousTrackedKw - trackedKw < HEADROOM_STEP_DOWN_THRESHOLD_KW) {
    return false;
  }

  const entry = ensureHeadroomEntry(state, deviceId);
  entry.lastStepDownMs = nowTs;
  const name = resolveHeadroomDeviceName({ state, deviceId, device, deviceName });
  if (name) {
    const reconciliation = resolveTrackedTransitionReconciliation({
      state,
      deviceId,
      nowTs,
      context: reconciliationContext,
    });
    diagnostics?.recordControlEvent({
      kind: 'tracked_usage_drop',
      deviceId,
      name,
      nowTs,
      fromKw: previousTrackedKw,
      toKw: trackedKw,
      reconciliation,
    });
  }
  // Tracked power changes are useful for diagnostics, but restore
  // failure/backoff belongs to explicit planner signals such as reconcile re-apply or
  // overshoot attribution. A normal device duty cycle must not become setback_failed here.
  return true;
};

const syncHeadroomCardTrackedKw = (params: {
  state: PlanEngineState;
  deviceId: string;
  trackedKw: number;
  trackedKwSource: HeadroomDeviceKwSource;
  trackedFreshnessMs?: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  deviceName?: string;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    deviceId,
    trackedKw,
    trackedKwSource,
    trackedFreshnessMs,
    nowTs,
    device,
    deviceName,
    reconciliationContext,
    diagnostics,
  } = params;
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId,
    nowTs,
    observation: device,
  });
  const name = resolveHeadroomDeviceName({ state, deviceId, device, deviceName });
  emitActivationTransitions(diagnostics, name, penaltyInfo.transitions);
  const previousEntry = state.headroomCardByDevice[deviceId];
  const previousTrackedKw = previousEntry?.lastObservedKw;
  let stateChanged = penaltyInfo.stateChanged;

  if (!isFiniteNumber(previousTrackedKw)) {
    updateHeadroomCardLastObserved({
      state,
      deviceId,
      trackedKw,
      trackedKwSource,
      trackedFreshnessMs,
      deviceName: name,
    });
    return stateChanged;
  }

  const mergeDecision = resolveTrackedUsageMergeDecision({
    entry: previousEntry,
    trackedKw,
    trackedKwSource,
    trackedFreshnessMs,
  });
  if (mergeDecision.skipUpdate) {
    incPerfCounter('tracked_usage_update_skipped_noop');
    if (mergeDecision.advanceFreshnessOnly) {
      updateHeadroomCardLastObserved({
        state,
        deviceId,
        trackedKw,
        trackedKwSource,
        trackedFreshnessMs,
        deviceName: name,
      });
    }
    return stateChanged;
  }

  stateChanged = maybeStartTrackedActivationAttempt({
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    deviceName: name,
    attemptOpen: penaltyInfo.attemptOpen,
    reconciliationContext,
    diagnostics,
  }) || stateChanged;

  stateChanged = maybeRecordTrackedStepDown({
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    deviceName: name,
    reconciliationContext,
    diagnostics,
  }) || stateChanged;

  updateHeadroomCardLastObserved({
    state,
    deviceId,
    trackedKw,
    trackedKwSource,
    trackedFreshnessMs,
    deviceName: name,
  });
  return stateChanged;
};

const syncHeadroomCardDevice = (params: {
  state: PlanEngineState;
  device: HeadroomCardDeviceLike;
  nowTs: number;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const { kw: trackedKw, source: trackedKwSource } = resolveTrackedHeadroomDeviceKw(params.device);
  return syncHeadroomCardTrackedKw({
    state: params.state,
    deviceId: params.device.id,
    trackedKw,
    trackedKwSource,
    trackedFreshnessMs: params.device.lastFreshDataMs,
    nowTs: params.nowTs,
    device: params.device,
    deviceName: params.device.name,
    reconciliationContext: params.reconciliationContext,
    diagnostics: params.diagnostics,
  });
};

const getPelsCooldown = (
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): HeadroomCooldownCandidate | null => {
  const lastShedMs = state.lastDeviceShedMs[deviceId];
  const lastRestoreMs = state.lastDeviceRestoreMs[deviceId];
  const shedExpiresAtMs = isFiniteNumber(lastShedMs) ? lastShedMs + SHED_COOLDOWN_MS : null;
  const restoreExpiresAtMs = isFiniteNumber(lastRestoreMs) ? lastRestoreMs + RESTORE_COOLDOWN_MS : null;

  const candidates: HeadroomCooldownCandidate[] = [];
  if (isFiniteNumber(shedExpiresAtMs) && shedExpiresAtMs > nowTs) {
    candidates.push({
      source: 'pels_shed',
      remainingSec: Math.max(0, Math.ceil((shedExpiresAtMs - nowTs) / 1000)),
      expiresAtMs: shedExpiresAtMs,
      startMs: lastShedMs,
      dropFromKw: null,
      dropToKw: null,
    });
  }
  if (isFiniteNumber(restoreExpiresAtMs) && restoreExpiresAtMs > nowTs) {
    candidates.push({
      source: 'pels_restore',
      remainingSec: Math.max(0, Math.ceil((restoreExpiresAtMs - nowTs) / 1000)),
      expiresAtMs: restoreExpiresAtMs,
      startMs: lastRestoreMs,
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
  return candidates[0];
};

export const syncHeadroomCardState = (params: {
  state: PlanEngineState;
  devices: HeadroomCardDeviceLike[];
  nowTs?: number;
  cleanupMissingDevices?: boolean;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    devices,
    cleanupMissingDevices = false,
    reconciliationContext,
    diagnostics,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  let stateChanged = false;

  if (cleanupMissingDevices) {
    stateChanged = cleanupMissingHeadroomDevices(state, devices);
  }

  for (const device of devices) {
    if (!syncHeadroomCardDevice({
      state,
      device,
      nowTs,
      reconciliationContext,
      diagnostics,
    })) continue;
    stateChanged = true;
  }

  return stateChanged;
};

export const syncHeadroomCardTrackedUsage = (params: {
  state: PlanEngineState;
  deviceId: string;
  trackedKw: number;
  trackedKwSource?: HeadroomDeviceKwSource;
  trackedFreshnessMs?: number;
  nowTs?: number;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => syncHeadroomCardTrackedKw({
  state: params.state,
  deviceId: params.deviceId,
  trackedKw: params.trackedKw,
  trackedKwSource: params.trackedKwSource ?? 'powerKw',
  trackedFreshnessMs: params.trackedFreshnessMs,
  nowTs: params.nowTs ?? Date.now(),
  reconciliationContext: params.reconciliationContext,
  diagnostics: params.diagnostics,
});

export const resolveHeadroomCardCooldown = (params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
}): HeadroomCooldownCandidate | null => {
  const { state, deviceId } = params;
  const nowTs = params.nowTs ?? Date.now();
  return getPelsCooldown(state, deviceId, nowTs);
};
