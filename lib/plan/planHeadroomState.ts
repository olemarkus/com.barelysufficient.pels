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
  resolveUsageObservationMergeDecision,
  resolveTrackedTransitionReconciliation,
  resolveHeadroomDeviceName,
  resolveHeadroomUsageKw,
  updateHeadroomCardUsageObservation,
  type HeadroomCardDeviceLike,
  type HeadroomCooldownCandidate,
  type HeadroomUsageObservation,
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
    delete entry.lastUsageKw;
    delete entry.lastUsageFreshnessMs;
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

const shouldSyncActivationPenaltyForDevice = (params: {
  state: PlanEngineState;
  deviceId: string;
  device: Pick<HeadroomCardDeviceLike, 'lastFreshDataMs'>;
}): boolean => {
  const previousFreshnessMs = params.state.headroomCardByDevice[params.deviceId]?.lastUsageFreshnessMs;
  const incomingFreshnessMs = params.device.lastFreshDataMs;
  const hasPreviousFreshness = isFiniteNumber(previousFreshnessMs);
  const hasIncomingFreshness = isFiniteNumber(incomingFreshnessMs);

  if (hasPreviousFreshness && !hasIncomingFreshness) return false;
  if (hasPreviousFreshness && hasIncomingFreshness && incomingFreshnessMs < previousFreshnessMs) return false;
  return true;
};

const shouldStartTrackedActivationAttempt = (params: {
  state: PlanEngineState;
  deviceId: string;
  previousUsageKw: number;
  usageKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  attemptOpen: boolean;
}): boolean => {
  const {
    state,
    deviceId,
    previousUsageKw,
    usageKw,
    nowTs,
    device,
    attemptOpen,
  } = params;
  if (usageKw - previousUsageKw < HEADROOM_STEP_DOWN_THRESHOLD_KW) return false;
  if (attemptOpen) return false;
  if (!isActivationObservationActiveNow(device)) return false;
  if (previousUsageKw <= HEADROOM_STEP_DOWN_THRESHOLD_KW) return true;
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
  previousUsageKw: number;
  usageKw: number;
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
    previousUsageKw,
    usageKw,
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
    previousUsageKw,
    usageKw,
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
      fromKw: previousUsageKw,
      toKw: usageKw,
      reconciliation,
    });
  }
  return false;
};

const maybeRecordTrackedStepDown = (params: {
  state: PlanEngineState;
  deviceId: string;
  previousUsageKw: number;
  usageKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  deviceName?: string;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    deviceId,
    previousUsageKw,
    usageKw,
    nowTs,
    device,
    deviceName,
    reconciliationContext,
    diagnostics,
  } = params;
  if (previousUsageKw - usageKw < HEADROOM_STEP_DOWN_THRESHOLD_KW) {
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
      fromKw: previousUsageKw,
      toKw: usageKw,
      reconciliation,
    });
  }
  // Tracked power changes are useful for diagnostics, but restore
  // failure/backoff belongs to explicit planner signals such as reconcile re-apply or
  // overshoot attribution. A normal device duty cycle must not become setback_failed here.
  return true;
};

const syncHeadroomUsageObservationEntry = (params: {
  state: PlanEngineState;
  deviceId: string;
  usageObservation: HeadroomUsageObservation;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  deviceName?: string;
  attemptOpen?: boolean;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    deviceId,
    usageObservation,
    nowTs,
    device,
    deviceName,
    attemptOpen = false,
    reconciliationContext,
    diagnostics,
  } = params;
  const previousEntry = state.headroomCardByDevice[deviceId];
  const previousUsageKw = previousEntry?.lastUsageKw;
  const mergeDecision = resolveUsageObservationMergeDecision({
    entry: previousEntry,
    usageObservation,
  });
  if (mergeDecision.outcome !== 'win') {
    incPerfCounter('tracked_usage_update_skipped_noop');
    if (mergeDecision.outcome === 'tie_refresh') {
      updateHeadroomCardUsageObservation({
        state,
        deviceId,
        usageObservation,
        deviceName: resolveHeadroomDeviceName({ state, deviceId, device, deviceName }),
      });
    }
    return false;
  }

  const name = resolveHeadroomDeviceName({ state, deviceId, device, deviceName });
  let stateChanged = false;

  if (!isFiniteNumber(previousUsageKw)) {
    updateHeadroomCardUsageObservation({
      state,
      deviceId,
      usageObservation,
      deviceName: name,
    });
    return stateChanged;
  }

  stateChanged = maybeStartTrackedActivationAttempt({
    state,
    deviceId,
    previousUsageKw,
    usageKw: usageObservation.kw,
    nowTs,
    device,
    deviceName: name,
    attemptOpen,
    reconciliationContext,
    diagnostics,
  }) || stateChanged;

  stateChanged = maybeRecordTrackedStepDown({
    state,
    deviceId,
    previousUsageKw,
    usageKw: usageObservation.kw,
    nowTs,
    device,
    deviceName: name,
    reconciliationContext,
    diagnostics,
  }) || stateChanged;

  updateHeadroomCardUsageObservation({
    state,
    deviceId,
    usageObservation,
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
  const shouldSyncPenalty = shouldSyncActivationPenaltyForDevice({
    state: params.state,
    deviceId: params.device.id,
    device: params.device,
  });
  let penaltyStateChanged = false;
  let attemptOpen = false;
  if (shouldSyncPenalty) {
    const penaltyInfo = syncActivationPenaltyState({
      state: params.state,
      deviceId: params.device.id,
      nowTs: params.nowTs,
      observation: params.device,
    });
    emitActivationTransitions(params.diagnostics, params.device.name, penaltyInfo.transitions);
    penaltyStateChanged = penaltyInfo.stateChanged;
    attemptOpen = penaltyInfo.attemptOpen;
  }

  const usageStateChanged = syncHeadroomUsageObservationEntry({
    state: params.state,
    deviceId: params.device.id,
    usageObservation: {
      kw: resolveHeadroomUsageKw(params.device),
      freshnessMs: params.device.lastFreshDataMs,
    },
    nowTs: params.nowTs,
    device: params.device,
    deviceName: params.device.name,
    attemptOpen,
    reconciliationContext: params.reconciliationContext,
    diagnostics: params.diagnostics,
  });
  return penaltyStateChanged || usageStateChanged;
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

export const syncHeadroomUsageObservation = (params: {
  state: PlanEngineState;
  deviceId: string;
  usageObservation: HeadroomUsageObservation;
  nowTs?: number;
  reconciliationContext?: HeadroomTrackedTransitionContext;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => syncHeadroomUsageObservationEntry({
  state: params.state,
  deviceId: params.deviceId,
  usageObservation: params.usageObservation,
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
