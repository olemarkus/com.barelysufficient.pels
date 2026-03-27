import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { HeadroomCardState, PlanEngineState } from './planState';
import {
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  closeActivationAttemptForDevice,
  isActivationObservationActiveNow,
  recordActivationAttemptStart,
  recordActivationSetback,
  syncActivationPenaltyState,
} from './planActivationBackoff';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';

export type HeadroomCardCooldownSource = 'step_down' | 'pels_shed' | 'pels_restore';

export type HeadroomCardDeviceLike = {
  id: string;
  name?: string;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  currentOn: boolean;
  currentState?: string;
  available?: boolean;
};

export type HeadroomCooldownCandidate = {
  source: HeadroomCardCooldownSource;
  remainingSec: number;
  expiresAtMs: number;
  startMs: number;
  dropFromKw: number | null;
  dropToKw: number | null;
};

const HEADROOM_STEP_DOWN_THRESHOLD_KW = 0.15;

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const ensureHeadroomEntry = (state: PlanEngineState, deviceId: string): HeadroomCardState => {
  const cards = state.headroomCardByDevice;
  if (!cards[deviceId]) {
    cards[deviceId] = {};
  }
  return cards[deviceId];
};

const removeStepDownCooldown = (cards: Record<string, HeadroomCardState>, deviceId: string): void => {
  const entry = cards[deviceId];
  if (!entry) return;
  delete entry.cooldownUntilMs;
  delete entry.cooldownFromKw;
  delete entry.cooldownToKw;
};

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
  }
  delete entry.lastStepDownMs;
  removeStepDownCooldown(cards, deviceId);
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

const clearExpiredStepDownCooldown = (
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): boolean => {
  const cards = state.headroomCardByDevice;
  const entry = cards[deviceId];
  if (!entry) return false;
  const expiresAtMs = entry.cooldownUntilMs;
  if (!isFiniteNumber(expiresAtMs) || expiresAtMs > nowTs) return false;
  removeStepDownCooldown(cards, deviceId);
  return true;
};

const updateHeadroomCardLastObserved = (
  state: PlanEngineState,
  deviceId: string,
  trackedKw: number,
): void => {
  const entry = ensureHeadroomEntry(state, deviceId);
  entry.lastObservedKw = trackedKw;
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
  name: string | undefined,
  transitions: Array<Parameters<DeviceDiagnosticsRecorder['recordActivationTransition']>[0]>,
): void => {
  if (!diagnostics || transitions.length === 0) return;
  for (const transition of transitions) {
    diagnostics.recordActivationTransition(transition, { name });
  }
};

const maybeStartStepDownCooldown = (params: {
  state: PlanEngineState;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
}): { stateChanged: boolean; started: boolean } => {
  const {
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
  } = params;
  if (previousTrackedKw - trackedKw < HEADROOM_STEP_DOWN_THRESHOLD_KW) {
    return { stateChanged: false, started: false };
  }

  const entry = ensureHeadroomEntry(state, deviceId);
  const nextUntilMs = nowTs + SHED_COOLDOWN_MS;
  if (
    entry.cooldownUntilMs === nextUntilMs
    && entry.cooldownFromKw === previousTrackedKw
    && entry.cooldownToKw === trackedKw
  ) {
    return { stateChanged: false, started: false };
  }

  entry.cooldownUntilMs = nextUntilMs;
  entry.cooldownFromKw = previousTrackedKw;
  entry.cooldownToKw = trackedKw;
  return { stateChanged: true, started: true };
};

const maybeStartTrackedActivationAttempt = (params: {
  state: PlanEngineState;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  attemptOpen: boolean;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    attemptOpen,
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

  const startResult = recordActivationAttemptStart({
    state,
    deviceId,
    source: 'tracked_step_up',
    nowTs,
  });
  if (startResult.started) {
    diagnostics?.recordControlEvent({
      kind: 'restore',
      origin: 'tracked',
      deviceId,
      name: device?.name,
      nowTs,
    });
  }
  if (startResult.transition) {
    diagnostics?.recordActivationTransition(startResult.transition, { name: device?.name });
  }
  return startResult.stateChanged;
};

const maybeRecordTrackedStepDown = (params: {
  state: PlanEngineState;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    diagnostics,
  } = params;
  const stepDownResult = maybeStartStepDownCooldown({
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
  });
  if (!stepDownResult.started || !device) {
    return stepDownResult.stateChanged;
  }

  const entry = ensureHeadroomEntry(state, deviceId);
  entry.lastStepDownMs = nowTs;
  diagnostics?.recordControlEvent({
    kind: 'shed',
    origin: 'tracked',
    deviceId,
    name: device.name,
    nowTs,
  });
  const setbackResult = recordActivationSetback({
    state,
    deviceId,
    nowTs,
  });
  if (setbackResult.transition) {
    diagnostics?.recordActivationTransition(setbackResult.transition, { name: device.name });
  }
  return stepDownResult.stateChanged || setbackResult.stateChanged;
};

const resolveTrackedHeadroomDeviceKw = (
  device: Pick<HeadroomCardDeviceLike, 'expectedPowerKw' | 'powerKw'>,
): number => {
  if (isFiniteNumber(device.expectedPowerKw)) return device.expectedPowerKw;
  if (isFiniteNumber(device.powerKw)) return device.powerKw;
  return 0;
};

export const resolveObservedHeadroomDeviceKw = (
  device: Pick<HeadroomCardDeviceLike, 'measuredPowerKw' | 'powerKw'>,
): number => {
  if (isFiniteNumber(device.measuredPowerKw)) return device.measuredPowerKw;
  if (isFiniteNumber(device.powerKw)) return device.powerKw;
  return 0;
};

const syncHeadroomCardTrackedKw = (params: {
  state: PlanEngineState;
  deviceId: string;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    deviceId,
    trackedKw,
    nowTs,
    device,
    diagnostics,
  } = params;
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId,
    nowTs,
    observation: device,
  });
  emitActivationTransitions(diagnostics, device?.name, penaltyInfo.transitions);
  const previousTrackedKw = state.headroomCardByDevice[deviceId]?.lastObservedKw;
  const expiredChanged = clearExpiredStepDownCooldown(state, deviceId, nowTs);
  let stateChanged = expiredChanged || penaltyInfo.stateChanged;

  if (!isFiniteNumber(previousTrackedKw)) {
    updateHeadroomCardLastObserved(state, deviceId, trackedKw);
    return stateChanged;
  }

  stateChanged = maybeStartTrackedActivationAttempt({
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    attemptOpen: penaltyInfo.attemptOpen,
    diagnostics,
  }) || stateChanged;

  stateChanged = maybeRecordTrackedStepDown({
    state,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    diagnostics,
  }) || stateChanged;

  updateHeadroomCardLastObserved(state, deviceId, trackedKw);
  return stateChanged;
};

const syncHeadroomCardDevice = (params: {
  state: PlanEngineState;
  device: HeadroomCardDeviceLike;
  nowTs: number;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => syncHeadroomCardTrackedKw({
  state: params.state,
  deviceId: params.device.id,
  trackedKw: resolveTrackedHeadroomDeviceKw(params.device),
  nowTs: params.nowTs,
  device: params.device,
  diagnostics: params.diagnostics,
});

const getStepDownCooldown = (
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): HeadroomCooldownCandidate | null => {
  const entry = state.headroomCardByDevice[deviceId];
  if (!entry) return null;
  const expiresAtMs = entry.cooldownUntilMs;
  if (!isFiniteNumber(expiresAtMs) || expiresAtMs <= nowTs) return null;
  return {
    source: 'step_down',
    remainingSec: Math.max(0, Math.ceil((expiresAtMs - nowTs) / 1000)),
    expiresAtMs,
    startMs: expiresAtMs - SHED_COOLDOWN_MS,
    dropFromKw: entry.cooldownFromKw ?? null,
    dropToKw: entry.cooldownToKw ?? null,
  };
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
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    devices,
    cleanupMissingDevices = false,
    diagnostics,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  let stateChanged = false;

  if (cleanupMissingDevices) {
    stateChanged = cleanupMissingHeadroomDevices(state, devices);
  }

  for (const device of devices) {
    if (!syncHeadroomCardDevice({ state, device, nowTs, diagnostics })) continue;
    stateChanged = true;
  }

  return stateChanged;
};

export const syncHeadroomCardTrackedUsage = (params: {
  state: PlanEngineState;
  deviceId: string;
  trackedKw: number;
  nowTs?: number;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => syncHeadroomCardTrackedKw({
  state: params.state,
  deviceId: params.deviceId,
  trackedKw: params.trackedKw,
  nowTs: params.nowTs ?? Date.now(),
  diagnostics: params.diagnostics,
});

export const resolveHeadroomCardCooldown = (params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
}): HeadroomCooldownCandidate | null => {
  const { state, deviceId } = params;
  const nowTs = params.nowTs ?? Date.now();
  const pelsCooldown = getPelsCooldown(state, deviceId, nowTs);
  const stepDownCooldown = getStepDownCooldown(state, deviceId, nowTs);
  if (!pelsCooldown) return stepDownCooldown;
  if (!stepDownCooldown) return pelsCooldown;
  if (pelsCooldown.expiresAtMs === stepDownCooldown.expiresAtMs) {
    return pelsCooldown;
  }
  return pelsCooldown.expiresAtMs > stepDownCooldown.expiresAtMs
    ? pelsCooldown
    : stepDownCooldown;
};
