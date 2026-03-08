import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { PlanEngineState } from './planState';
import {
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  applyActivationPenalty,
  closeActivationAttemptForDevice,
  isActivationObservationActiveNow,
  recordActivationAttemptStart,
  recordActivationSetback,
  syncActivationPenaltyState,
} from './planActivationBackoff';

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

export type HeadroomForDeviceDecision = {
  allowed: boolean;
  cooldownSource: HeadroomCardCooldownSource | null;
  cooldownRemainingSec: number | null;
  observedKw: number;
  calculatedHeadroomForDeviceKw: number;
  penaltyLevel: number;
  requiredKwWithPenalty: number;
  stickRemainingSec: number | null;
  clearRemainingSec: number | null;
  dropFromKw: number | null;
  dropToKw: number | null;
  stateChanged: boolean;
};

type HeadroomCooldownCandidate = {
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

const syncHeadroomCardTrackedKw = (params: {
  state: PlanEngineState;
  deviceId: string;
  trackedKw: number;
  nowTs: number;
  device?: HeadroomCardDeviceLike;
}): boolean => {
  const {
    state,
    deviceId,
    trackedKw,
    nowTs,
    device,
  } = params;
  const maps = getHeadroomCardStateMaps(state);
  let stateChanged = false;
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId,
    nowTs,
    observation: device,
  });
  stateChanged = penaltyInfo.stateChanged;
  const previousTrackedKw = maps.lastObservedKw[deviceId];
  const expiredChanged = clearExpiredStepDownCooldown(maps, deviceId, nowTs);
  stateChanged = expiredChanged || stateChanged;

  if (!isFiniteNumber(previousTrackedKw)) {
    updateHeadroomCardLastObserved(maps, deviceId, trackedKw);
    return stateChanged;
  }

  if (shouldStartTrackedActivationAttempt({
    maps,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
    device,
    attemptOpen: penaltyInfo.attemptOpen,
  })) {
    stateChanged = recordActivationAttemptStart({
      state,
      deviceId,
      source: 'tracked_step_up',
      nowTs,
    }) || stateChanged;
  }

  const stepDownResult = maybeStartStepDownCooldown({
    maps,
    deviceId,
    previousTrackedKw,
    trackedKw,
    nowTs,
  });
  stateChanged = stepDownResult.stateChanged || stateChanged;
  if (stepDownResult.started && device) {
    maps.lastStepDownMs[deviceId] = nowTs;
    stateChanged = recordActivationSetback({
      state,
      deviceId,
      nowTs,
    }).stateChanged || stateChanged;
  }
  updateHeadroomCardLastObserved(maps, deviceId, trackedKw);
  return stateChanged;
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

  const {
    cooldownUntilMs,
    cooldownFromKw,
    cooldownToKw,
  } = maps;
  const nextUntilMs = nowTs + SHED_COOLDOWN_MS;
  if (
    cooldownUntilMs[deviceId] === nextUntilMs
    && cooldownFromKw[deviceId] === previousTrackedKw
    && cooldownToKw[deviceId] === trackedKw
  ) {
    return { stateChanged: false, started: false };
  }

  cooldownUntilMs[deviceId] = nextUntilMs;
  cooldownFromKw[deviceId] = previousTrackedKw;
  cooldownToKw[deviceId] = trackedKw;
  return { stateChanged: true, started: true };
};

const syncHeadroomCardDevice = (params: {
  state: PlanEngineState;
  device: HeadroomCardDeviceLike;
  nowTs: number;
}): boolean => {
  const {
    state,
    device,
    nowTs,
  } = params;
  const deviceId = device.id;
  const trackedKw = resolveTrackedHeadroomDeviceKw(device);
  return syncHeadroomCardTrackedKw({
    state,
    deviceId,
    trackedKw,
    nowTs,
    device,
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

  candidates.sort((a, b) => {
    if (a.expiresAtMs !== b.expiresAtMs) return b.expiresAtMs - a.expiresAtMs;
    if (a.startMs !== b.startMs) return b.startMs - a.startMs;
    if (a.source === b.source) return 0;
    if (a.source === 'pels_restore') return -1;
    if (b.source === 'pels_restore') return 1;
    return 0;
  });
  return candidates[0];
};

export const resolveObservedHeadroomDeviceKw = (
  device: Pick<HeadroomCardDeviceLike, 'measuredPowerKw' | 'powerKw'>,
): number => {
  if (isFiniteNumber(device.measuredPowerKw)) return device.measuredPowerKw;
  if (isFiniteNumber(device.powerKw)) return device.powerKw;
  return 0;
};

const resolveTrackedHeadroomDeviceKw = (
  device: Pick<HeadroomCardDeviceLike, 'expectedPowerKw' | 'powerKw'>,
): number => {
  if (isFiniteNumber(device.expectedPowerKw)) return device.expectedPowerKw;
  if (isFiniteNumber(device.powerKw)) return device.powerKw;
  return 0;
};

export const syncHeadroomCardState = (params: {
  state: PlanEngineState;
  devices: HeadroomCardDeviceLike[];
  nowTs?: number;
  cleanupMissingDevices?: boolean;
}): boolean => {
  const {
    state,
    devices,
    cleanupMissingDevices = false,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  const maps = getHeadroomCardStateMaps(state);
  let stateChanged = false;

  if (cleanupMissingDevices) {
    stateChanged = cleanupMissingHeadroomDevices(state, maps, devices);
  }

  for (const device of devices) {
    if (!syncHeadroomCardDevice({ state, device, nowTs })) continue;
    stateChanged = true;
  }

  return stateChanged;
};

export const syncHeadroomCardTrackedUsage = (params: {
  state: PlanEngineState;
  deviceId: string;
  trackedKw: number;
  nowTs?: number;
}): boolean => {
  const {
    state,
    deviceId,
    trackedKw,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  return syncHeadroomCardTrackedKw({
    state,
    deviceId,
    trackedKw,
    nowTs,
  });
};

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

export const evaluateHeadroomForDevice = (params: {
  state: PlanEngineState;
  devices: HeadroomCardDeviceLike[];
  deviceId: string;
  device?: HeadroomCardDeviceLike;
  headroom: number;
  requiredKw: number;
  nowTs?: number;
  cleanupMissingDevices?: boolean;
}): HeadroomForDeviceDecision | null => {
  const {
    state,
    devices,
    deviceId,
    device: providedDevice,
    headroom,
    requiredKw,
    cleanupMissingDevices = false,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  const stateChanged = syncHeadroomCardState({
    state,
    devices,
    nowTs,
    cleanupMissingDevices,
  });
  const device = providedDevice ?? devices.find((entry) => entry.id === deviceId);
  if (!device) return null;
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId,
    nowTs,
    observation: device,
  });

  const observedKw = resolveObservedHeadroomDeviceKw(device);
  const calculatedHeadroomForDeviceKw = headroom + observedKw;
  const penalty = applyActivationPenalty({
    baseRequiredKw: requiredKw,
    penaltyLevel: penaltyInfo.penaltyLevel,
  });
  const cooldown = resolveHeadroomCardCooldown({
    state,
    deviceId,
    nowTs,
  });
  return {
    allowed: cooldown === null && calculatedHeadroomForDeviceKw >= penalty.requiredKwWithPenalty,
    cooldownSource: cooldown?.source ?? null,
    cooldownRemainingSec: cooldown?.remainingSec ?? null,
    observedKw,
    calculatedHeadroomForDeviceKw,
    penaltyLevel: penaltyInfo.penaltyLevel,
    requiredKwWithPenalty: penalty.requiredKwWithPenalty,
    stickRemainingSec: penaltyInfo.stickRemainingSec,
    clearRemainingSec: penaltyInfo.clearRemainingSec,
    dropFromKw: cooldown?.dropFromKw ?? null,
    dropToKw: cooldown?.dropToKw ?? null,
    stateChanged: stateChanged || penaltyInfo.stateChanged,
  };
};

export const formatHeadroomCooldownReason = (params: {
  source: HeadroomCardCooldownSource;
  remainingSec: number;
  dropFromKw?: number | null;
  dropToKw?: number | null;
}): string => {
  const { source, remainingSec, dropFromKw, dropToKw } = params;
  if (source === 'step_down') {
    const fromText = isFiniteNumber(dropFromKw) ? dropFromKw.toFixed(2) : 'unknown';
    const toText = isFiniteNumber(dropToKw) ? dropToKw.toFixed(2) : 'unknown';
    return `headroom cooldown (${remainingSec}s remaining; usage ${fromText} -> ${toText}kW)`;
  }
  if (source === 'pels_shed') {
    return `headroom cooldown (${remainingSec}s remaining; recent PELS shed)`;
  }
  return `headroom cooldown (${remainingSec}s remaining; recent PELS restore)`;
};
