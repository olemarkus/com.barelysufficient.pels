import type { PlanEngineState, ActivationAttemptSource } from './planState';
import type { DeviceDiagnosticsBackoffTransition } from '../diagnostics/deviceDiagnosticsService';

export type { ActivationAttemptSource } from './planState';

export const ACTIVATION_BACKOFF_STICK_WINDOW_MS = 10 * 60 * 1000;
export const ACTIVATION_BACKOFF_CLEAR_WINDOW_MS = 30 * 60 * 1000;
export const ACTIVATION_BACKOFF_MAX_LEVEL = 4;
export const ACTIVATION_SETBACK_RESTORE_BLOCK_MS = ACTIVATION_BACKOFF_STICK_WINDOW_MS;

export type ActivationBackoffObservation = {
  available?: boolean;
  currentOn: boolean;
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
  source: ActivationAttemptSource | null;
  transitions: DeviceDiagnosticsBackoffTransition[];
};

const MIN_ACTIVE_MEASURED_POWER_KW = 0.05;

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const ensureAttemptEntry = (state: PlanEngineState, deviceId: string) => {
  const attempts = state.activationAttemptByDevice;
  if (!attempts[deviceId]) {
    attempts[deviceId] = {};
  }
  return attempts[deviceId];
};

const getPenaltyLevel = (state: PlanEngineState, deviceId: string): number => {
  const attempts = state.activationAttemptByDevice;
  const value = attempts[deviceId]?.penaltyLevel;
  return isFiniteNumber(value) && value > 0 ? Math.min(value, ACTIVATION_BACKOFF_MAX_LEVEL) : 0;
};

export function getActivationPenaltyLevel(state: PlanEngineState, deviceId: string): number {
  return getPenaltyLevel(state, deviceId);
}

const readLastSetbackMs = (state: PlanEngineState, deviceId: string): number | null => {
  const attempts = state.activationAttemptByDevice;
  const value = attempts[deviceId]?.lastSetbackMs;
  return isFiniteNumber(value) ? value : null;
};

const setPenaltyLevel = (state: PlanEngineState, deviceId: string, level: number): boolean => {
  const nextLevel = Math.max(0, Math.min(ACTIVATION_BACKOFF_MAX_LEVEL, Math.trunc(level)));
  const currentLevel = getPenaltyLevel(state, deviceId);
  if (currentLevel === nextLevel) return false;
  if (nextLevel === 0) {
    const attempts = state.activationAttemptByDevice;
    const entry = attempts[deviceId];
    if (entry) {
      delete entry.penaltyLevel;
      delete entry.lastSetbackMs;
      if (Object.keys(entry).length === 0) {
        delete attempts[deviceId];
      }
    }
    return true;
  }
  const entry = ensureAttemptEntry(state, deviceId);
  entry.penaltyLevel = nextLevel;
  return true;
};

const clearAttemptState = (state: PlanEngineState, deviceId: string): boolean => {
  const attempts = state.activationAttemptByDevice;
  const entry = attempts[deviceId];
  if (!entry) return false;
  let stateChanged = false;
  if ('startedMs' in entry) {
    delete entry.startedMs;
    stateChanged = true;
  }
  if ('source' in entry) {
    delete entry.source;
    stateChanged = true;
  }
  if ('stickReached' in entry) {
    delete entry.stickReached;
    stateChanged = true;
  }
  if (stateChanged && Object.keys(entry).length === 0) {
    delete attempts[deviceId];
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
  const attempts = state.activationAttemptByDevice;
  const value = attempts[deviceId]?.startedMs;
  return isFiniteNumber(value) ? value : null;
};

const readAttemptSource = (
  state: PlanEngineState,
  deviceId: string,
): ActivationAttemptSource | null => {
  const attempts = state.activationAttemptByDevice;
  const value = attempts[deviceId]?.source;
  return value === 'pels_restore' || value === 'tracked_step_up' ? value : null;
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

function syncOpenAttempt(params: {
  state: PlanEngineState;
  deviceId: string;
  attemptStartedMs: number;
  nowTs: number;
  observation?: ActivationBackoffObservation;
  penaltyLevel: number;
  source: ActivationAttemptSource | null;
  stateChanged: boolean;
  transitions: DeviceDiagnosticsBackoffTransition[];
}): ActivationPenaltyInfo {
  const {
    state, deviceId, attemptStartedMs, nowTs, observation, source, transitions,
  } = params;
  let { penaltyLevel, stateChanged } = params;

  const elapsedMs = Math.max(0, nowTs - attemptStartedMs);
  const entry = ensureAttemptEntry(state, deviceId);
  let stickReached = entry.stickReached === true;
  if (!stickReached && elapsedMs >= ACTIVATION_BACKOFF_STICK_WINDOW_MS) {
    entry.stickReached = true;
    stickReached = true;
    stateChanged = true;
    transitions.push({
      kind: 'stick_reached',
      deviceId,
      source,
      penaltyLevel,
      elapsedMs,
      nowTs,
    });
  }

  if (elapsedMs >= ACTIVATION_BACKOFF_CLEAR_WINDOW_MS && isActivationObservationActiveNow(observation)) {
    const previousPenaltyLevel = penaltyLevel;
    stateChanged = setPenaltyLevel(state, deviceId, 0) || stateChanged;
    penaltyLevel = 0;
    stateChanged = clearAttemptState(state, deviceId) || stateChanged;
    transitions.push({
      kind: 'penalty_cleared',
      deviceId,
      source,
      previousPenaltyLevel,
      elapsedMs,
      nowTs,
    });
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: null,
      stateChanged,
      source,
      transitions,
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
    source,
    transitions,
  };
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
  const penaltyLevel = getPenaltyLevel(state, deviceId);
  const transitions: DeviceDiagnosticsBackoffTransition[] = [];

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
      source: null,
      transitions,
    };
  }
  const source = readAttemptSource(state, deviceId);

  if (isActivationObservationExplicitlyInactive(observation)) {
    const elapsedMs = Math.max(0, nowTs - attemptStartedMs);
    stateChanged = clearAttemptState(state, deviceId);
    transitions.push({
      kind: 'attempt_closed_inactive',
      deviceId,
      source,
      penaltyLevel,
      elapsedMs,
      nowTs,
    });
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: null,
      stateChanged,
      source,
      transitions,
    };
  }

  return syncOpenAttempt({
    state,
    deviceId,
    attemptStartedMs,
    nowTs,
    observation,
    penaltyLevel,
    source,
    stateChanged,
    transitions,
  });
}

export function recordActivationAttemptStart(params: {
  state: PlanEngineState;
  deviceId: string;
  source: ActivationAttemptSource;
  nowTs?: number;
}): {
  stateChanged: boolean;
  started: boolean;
  transition?: DeviceDiagnosticsBackoffTransition;
} {
  const {
    state,
    deviceId,
    source,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  if (!deviceId || !Number.isFinite(nowTs)) {
    return { stateChanged: false, started: false };
  }
  if (readAttemptStartedMs(state, deviceId) !== null) {
    return { stateChanged: false, started: false };
  }
  const penaltyLevel = getPenaltyLevel(state, deviceId);
  const entry = ensureAttemptEntry(state, deviceId);
  entry.startedMs = nowTs;
  entry.source = source;
  entry.stickReached = false;
  return {
    stateChanged: true,
    started: true,
    transition: {
      kind: 'attempt_started',
      deviceId,
      source,
      penaltyLevel,
      nowTs,
    },
  };
}

export function recordActivationSetback(params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
}): {
  stateChanged: boolean;
  bumped: boolean;
  penaltyLevel: number;
  transition?: DeviceDiagnosticsBackoffTransition;
} {
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
  const source = readAttemptSource(state, deviceId);
  const previousPenaltyLevel = penaltyLevel;
  const attempts = state.activationAttemptByDevice;
  const entry = attempts[deviceId];
  const stickReached = entry?.stickReached === true
    || elapsedMs >= ACTIVATION_BACKOFF_STICK_WINDOW_MS;
  let stateChanged = clearAttemptState(state, deviceId);
  let bumped = false;
  if (!stickReached) {
    stateChanged = setPenaltyLevel(state, deviceId, penaltyLevel + 1) || stateChanged;
    penaltyLevel = getPenaltyLevel(state, deviceId);
    bumped = true;
  }
  // Always refresh lastSetbackMs so the 10-minute restore block restarts, even when
  // stickReached is true. Without this, post-stick sheddings leave the time block
  // unrefreshed and the device can be restored as soon as the global cooldown expires.
  const setbackEntry = ensureAttemptEntry(state, deviceId);
  if (setbackEntry.lastSetbackMs !== nowTs) {
    setbackEntry.lastSetbackMs = nowTs;
    stateChanged = true;
  }
  return {
    stateChanged,
    bumped,
    penaltyLevel,
    transition: bumped
      ? {
        kind: 'setback_failed',
        deviceId,
        source,
        previousPenaltyLevel,
        penaltyLevel,
        elapsedMs,
        nowTs,
      }
      : {
        kind: 'setback_after_stick',
        deviceId,
        source,
        penaltyLevel,
        elapsedMs,
        nowTs,
      },
  };
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

export function getActivationRestoreBlockRemainingMs(params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
}): number | null {
  const {
    state,
    deviceId,
  } = params;
  if (getPenaltyLevel(state, deviceId) <= 0) return null;
  const lastSetbackMs = readLastSetbackMs(state, deviceId);
  if (lastSetbackMs === null) return null;
  const nowTs = params.nowTs ?? Date.now();
  const elapsedMs = Math.max(0, nowTs - lastSetbackMs);
  const remainingMs = ACTIVATION_SETBACK_RESTORE_BLOCK_MS - elapsedMs;
  return remainingMs > 0 ? remainingMs : null;
}
