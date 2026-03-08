import type { PlanEngineState } from './planState';

export const ACTIVATION_BACKOFF_STICK_WINDOW_MS = 10 * 60 * 1000;
export const ACTIVATION_BACKOFF_CLEAR_WINDOW_MS = 30 * 60 * 1000;
export const ACTIVATION_BACKOFF_MAX_LEVEL = 4;

export type ActivationAttemptSource = 'pels_restore' | 'tracked_step_up';

export type ActivationBackoffObservation = {
  available?: boolean;
  currentOn?: boolean;
  currentState?: string;
  measuredPowerKw?: number;
};

export type ActivationPenaltyInfo = {
  penaltyLevel: number;
  attemptOpen: boolean;
  stickReached: boolean;
  stickRemainingSec: number | null;
  clearRemainingSec: number | null;
  stateChanged: boolean;
};

const MIN_ACTIVE_MEASURED_POWER_KW = 0.05;

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const getPenaltyLevel = (state: PlanEngineState, deviceId: string): number => {
  const value = state.activationPenaltyLevelByDevice[deviceId];
  return isFiniteNumber(value) && value > 0 ? Math.min(value, ACTIVATION_BACKOFF_MAX_LEVEL) : 0;
};

const setPenaltyLevel = (state: PlanEngineState, deviceId: string, level: number): boolean => {
  const penaltyLevels = state.activationPenaltyLevelByDevice;
  const nextLevel = Math.max(0, Math.min(ACTIVATION_BACKOFF_MAX_LEVEL, Math.trunc(level)));
  const currentLevel = getPenaltyLevel(state, deviceId);
  if (currentLevel === nextLevel) return false;
  if (nextLevel === 0) {
    delete penaltyLevels[deviceId];
    return true;
  }
  penaltyLevels[deviceId] = nextLevel;
  return true;
};

const clearAttemptState = (state: PlanEngineState, deviceId: string): boolean => {
  const attemptStarted = state.activationAttemptStartedMsByDevice;
  const attemptSources = state.activationAttemptSourceByDevice;
  const attemptStickReached = state.activationAttemptStickReachedByDevice;
  let stateChanged = false;
  if (deviceId in attemptStarted) {
    delete attemptStarted[deviceId];
    stateChanged = true;
  }
  if (deviceId in attemptSources) {
    delete attemptSources[deviceId];
    stateChanged = true;
  }
  if (deviceId in attemptStickReached) {
    delete attemptStickReached[deviceId];
    stateChanged = true;
  }
  return stateChanged;
};

export function closeActivationAttemptForDevice(
  state: PlanEngineState,
  deviceId: string,
): boolean {
  return clearAttemptState(state, deviceId);
}

const readAttemptStartedMs = (state: PlanEngineState, deviceId: string): number | null => {
  const value = state.activationAttemptStartedMsByDevice[deviceId];
  return isFiniteNumber(value) ? value : null;
};

export function isActivationObservationExplicitlyInactive(
  observation?: ActivationBackoffObservation,
): boolean {
  if (!observation) return false;
  if (observation.available === false) return true;
  if (observation.currentOn === false) return true;
  if (observation.currentState === 'off' || observation.currentState === 'inactive') return true;
  return false;
}

export function isActivationObservationActiveNow(
  observation?: ActivationBackoffObservation,
): boolean {
  if (!observation) return false;
  if (observation.available === false) return false;
  if (observation.currentOn === true) return true;
  if (observation.currentState === 'on') return true;
  return isFiniteNumber(observation.measuredPowerKw) && observation.measuredPowerKw > MIN_ACTIVE_MEASURED_POWER_KW;
}

export function syncActivationPenaltyState(params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
  observation?: ActivationBackoffObservation;
}): ActivationPenaltyInfo {
  const {
    state,
    deviceId,
    observation,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  let stateChanged = false;
  let penaltyLevel = getPenaltyLevel(state, deviceId);

  const attemptStartedMs = readAttemptStartedMs(state, deviceId);
  if (attemptStartedMs === null) {
    const cleared = clearAttemptState(state, deviceId);
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: null,
      stateChanged: cleared,
    };
  }

  if (isActivationObservationExplicitlyInactive(observation)) {
    stateChanged = clearAttemptState(state, deviceId);
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: null,
      stateChanged,
    };
  }

  const elapsedMs = Math.max(0, nowTs - attemptStartedMs);
  let stickReached = state.activationAttemptStickReachedByDevice[deviceId] === true;
  if (!stickReached && elapsedMs >= ACTIVATION_BACKOFF_STICK_WINDOW_MS) {
    state.activationAttemptStickReachedByDevice[deviceId] = true;
    stickReached = true;
    stateChanged = true;
  }

  if (elapsedMs >= ACTIVATION_BACKOFF_CLEAR_WINDOW_MS && isActivationObservationActiveNow(observation)) {
    stateChanged = setPenaltyLevel(state, deviceId, 0) || stateChanged;
    penaltyLevel = 0;
    stateChanged = clearAttemptState(state, deviceId) || stateChanged;
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: null,
      stateChanged,
    };
  }

  return {
    penaltyLevel,
    attemptOpen: true,
    stickReached,
    stickRemainingSec: stickReached
      ? 0
      : Math.max(0, Math.ceil((ACTIVATION_BACKOFF_STICK_WINDOW_MS - elapsedMs) / 1000)),
    clearRemainingSec: Math.max(0, Math.ceil((ACTIVATION_BACKOFF_CLEAR_WINDOW_MS - elapsedMs) / 1000)),
    stateChanged,
  };
}

export function recordActivationAttemptStart(params: {
  state: PlanEngineState;
  deviceId: string;
  source: ActivationAttemptSource;
  nowTs?: number;
}): boolean {
  const {
    state,
    deviceId,
    source,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  if (!deviceId || !Number.isFinite(nowTs)) return false;
  if (readAttemptStartedMs(state, deviceId) !== null) return false;
  state.activationAttemptStartedMsByDevice[deviceId] = nowTs;
  state.activationAttemptSourceByDevice[deviceId] = source;
  state.activationAttemptStickReachedByDevice[deviceId] = false;
  return true;
}

export function recordActivationSetback(params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
}): { stateChanged: boolean; bumped: boolean; penaltyLevel: number } {
  const {
    state,
    deviceId,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  const attemptStartedMs = readAttemptStartedMs(state, deviceId);
  let penaltyLevel = getPenaltyLevel(state, deviceId);
  if (attemptStartedMs === null) {
    return { stateChanged: false, bumped: false, penaltyLevel };
  }

  const elapsedMs = Math.max(0, nowTs - attemptStartedMs);
  const stickReached = state.activationAttemptStickReachedByDevice[deviceId] === true
    || elapsedMs >= ACTIVATION_BACKOFF_STICK_WINDOW_MS;
  let stateChanged = clearAttemptState(state, deviceId);
  let bumped = false;
  if (!stickReached) {
    stateChanged = setPenaltyLevel(state, deviceId, penaltyLevel + 1) || stateChanged;
    penaltyLevel = getPenaltyLevel(state, deviceId);
    bumped = true;
  }
  return { stateChanged, bumped, penaltyLevel };
}

export function applyActivationPenalty(params: {
  baseRequiredKw: number;
  penaltyLevel: number;
}): { requiredKwWithPenalty: number; penaltyExtraKw: number } {
  const baseRequiredKw = Math.max(0, Number.isFinite(params.baseRequiredKw) ? params.baseRequiredKw : 0);
  const penaltyLevel = Math.max(0, Math.min(ACTIVATION_BACKOFF_MAX_LEVEL, Math.trunc(params.penaltyLevel)));
  if (penaltyLevel === 0 || baseRequiredKw <= 0) {
    return { requiredKwWithPenalty: baseRequiredKw, penaltyExtraKw: 0 };
  }

  const factorExtra = Math.min(1, 0.15 * (2 ** (penaltyLevel - 1)));
  const absoluteExtraKw = Math.min(1.2, 0.15 * (2 ** (penaltyLevel - 1)));
  const requiredKwWithPenalty = Math.max(
    baseRequiredKw * (1 + factorExtra),
    baseRequiredKw + absoluteExtraKw,
  );
  return {
    requiredKwWithPenalty,
    penaltyExtraKw: Math.max(0, requiredKwWithPenalty - baseRequiredKw),
  };
}
