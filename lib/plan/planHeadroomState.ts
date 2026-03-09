import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { PlanEngineState } from './planState';
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
  currentOn?: boolean;
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

type HeadroomCardStateMaps = {
  lastObservedKw: Record<string, number>;
  lastStepDownMs: Record<string, number>;
  cooldownUntilMs: Record<string, number>;
  cooldownFromKw: Record<string, number>;
  cooldownToKw: Record<string, number>;
};

const HEADROOM_STEP_DOWN_THRESHOLD_KW = 0.15;

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const getHeadroomCardStateMaps = (state: PlanEngineState): HeadroomCardStateMaps => ({
  lastObservedKw: state.headroomCardLastObservedKw,
  lastStepDownMs: state.headroomCardLastStepDownMs,
  cooldownUntilMs: state.headroomCardCooldownUntilMs,
  cooldownFromKw: state.headroomCardCooldownFromKw,
  cooldownToKw: state.headroomCardCooldownToKw,
});

const removeStepDownCooldown = (maps: HeadroomCardStateMaps, deviceId: string): void => {
  const {
    cooldownUntilMs,
    cooldownFromKw,
    cooldownToKw,
  } = maps;
  delete cooldownUntilMs[deviceId];
  delete cooldownFromKw[deviceId];
  delete cooldownToKw[deviceId];
};

const removeHeadroomCardStateForDevice = (
  maps: HeadroomCardStateMaps,
  deviceId: string,
  options: { keepLastObserved?: boolean } = {},
): void => {
  const { lastObservedKw, lastStepDownMs } = maps;
  if (!options.keepLastObserved) {
    delete lastObservedKw[deviceId];
  }
  delete lastStepDownMs[deviceId];
  removeStepDownCooldown(maps, deviceId);
};

const collectTrackedDeviceIds = (maps: HeadroomCardStateMaps): Set<string> => new Set([
  ...Object.keys(maps.lastObservedKw),
  ...Object.keys(maps.lastStepDownMs),
  ...Object.keys(maps.cooldownUntilMs),
  ...Object.keys(maps.cooldownFromKw),
  ...Object.keys(maps.cooldownToKw),
]);

const cleanupMissingHeadroomDevices = (
  state: PlanEngineState,
  maps: HeadroomCardStateMaps,
  devices: HeadroomCardDeviceLike[],
): boolean => {
  let stateChanged = false;
  const activeIds = new Set(devices.map((device) => device.id));
  const trackedIds = collectTrackedDeviceIds(maps);
  for (const deviceId of trackedIds) {
    if (activeIds.has(deviceId)) continue;
    removeHeadroomCardStateForDevice(maps, deviceId);
    // A missing snapshot should close any open attempt, but it must not forgive prior failed activations.
    stateChanged = closeActivationAttemptForDevice(state, deviceId) || stateChanged;
    stateChanged = true;
  }
  return stateChanged;
};

const clearExpiredStepDownCooldown = (
  maps: HeadroomCardStateMaps,
  deviceId: string,
  nowTs: number,
): boolean => {
  const expiresAtMs = maps.cooldownUntilMs[deviceId];
  if (!isFiniteNumber(expiresAtMs) || expiresAtMs > nowTs) return false;
  removeStepDownCooldown(maps, deviceId);
  return true;
};

const updateHeadroomCardLastObserved = (
  maps: HeadroomCardStateMaps,
  deviceId: string,
  trackedKw: number,
): void => {
  const { lastObservedKw } = maps;
  lastObservedKw[deviceId] = trackedKw;
};

const wasRecentlySteppedDown = (
  maps: HeadroomCardStateMaps,
  deviceId: string,
  nowTs: number,
): boolean => {
  const lastStepDownMs = maps.lastStepDownMs[deviceId];
  if (!isFiniteNumber(lastStepDownMs)) return false;
  return nowTs - lastStepDownMs < ACTIVATION_BACKOFF_CLEAR_WINDOW_MS;
};

const shouldStartTrackedActivationAttempt = (params: {
  maps: HeadroomCardStateMaps;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  attemptOpen: boolean;
}): boolean => {
  const {
    maps,
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
  return wasRecentlySteppedDown(maps, deviceId, nowTs);
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
  maps: HeadroomCardStateMaps;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
}): { stateChanged: boolean; started: boolean } => {
  const {
    maps,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
  } = params;
  if (previousTrackedKw - trackedKw < HEADROOM_STEP_DOWN_THRESHOLD_KW) {
    return { stateChanged: false, started: false };
  }

  const nextUntilMs = nowTs + SHED_COOLDOWN_MS;
  if (
    maps.cooldownUntilMs[deviceId] === nextUntilMs
    && maps.cooldownFromKw[deviceId] === previousTrackedKw
    && maps.cooldownToKw[deviceId] === trackedKw
  ) {
    return { stateChanged: false, started: false };
  }

  const {
    cooldownUntilMs,
    cooldownFromKw,
    cooldownToKw,
  } = maps;
  cooldownUntilMs[deviceId] = nextUntilMs;
  cooldownFromKw[deviceId] = previousTrackedKw;
  cooldownToKw[deviceId] = trackedKw;
  return { stateChanged: true, started: true };
};

const maybeStartTrackedActivationAttempt = (params: {
  state: PlanEngineState;
  maps: HeadroomCardStateMaps;
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
    maps,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    attemptOpen,
    diagnostics,
  } = params;
  if (!shouldStartTrackedActivationAttempt({
    maps,
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
  maps: HeadroomCardStateMaps;
  deviceId: string;
  previousTrackedKw: number;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
  diagnostics?: DeviceDiagnosticsRecorder;
}): boolean => {
  const {
    state,
    maps,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    diagnostics,
  } = params;
  const stepDownResult = maybeStartStepDownCooldown({
    maps,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
  });
  if (!stepDownResult.started || !device) {
    return stepDownResult.stateChanged;
  }

  const { lastStepDownMs } = maps;
  lastStepDownMs[deviceId] = nowTs;
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
  const maps = getHeadroomCardStateMaps(state);
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId,
    nowTs,
    observation: device,
  });
  emitActivationTransitions(diagnostics, device?.name, penaltyInfo.transitions);
  const previousTrackedKw = maps.lastObservedKw[deviceId];
  const expiredChanged = clearExpiredStepDownCooldown(maps, deviceId, nowTs);
  let stateChanged = expiredChanged || penaltyInfo.stateChanged;

  if (!isFiniteNumber(previousTrackedKw)) {
    updateHeadroomCardLastObserved(maps, deviceId, trackedKw);
    return stateChanged;
  }

  stateChanged = maybeStartTrackedActivationAttempt({
    state,
    maps,
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
    maps,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    diagnostics,
  }) || stateChanged;

  updateHeadroomCardLastObserved(maps, deviceId, trackedKw);
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
  const maps = getHeadroomCardStateMaps(state);
  const expiresAtMs = maps.cooldownUntilMs[deviceId];
  if (!isFiniteNumber(expiresAtMs) || expiresAtMs <= nowTs) return null;
  return {
    source: 'step_down',
    remainingSec: Math.max(0, Math.ceil((expiresAtMs - nowTs) / 1000)),
    expiresAtMs,
    startMs: expiresAtMs - SHED_COOLDOWN_MS,
    dropFromKw: maps.cooldownFromKw[deviceId] ?? null,
    dropToKw: maps.cooldownToKw[deviceId] ?? null,
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
  const maps = getHeadroomCardStateMaps(state);
  let stateChanged = false;

  if (cleanupMissingDevices) {
    stateChanged = cleanupMissingHeadroomDevices(state, maps, devices);
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
