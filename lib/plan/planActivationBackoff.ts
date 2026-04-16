import type {
  ActivationAttemptState,
  ActivationAttemptSource,
  PlanEngineState,
} from './planState';
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

const clampPenaltyLevel = (value: unknown): number => {
  if (!isFiniteNumber(value) || value <= 0) return 0;
  return Math.min(ACTIVATION_BACKOFF_MAX_LEVEL, Math.trunc(value));
};

const getAttempt = (state: PlanEngineState, deviceId: string): ActivationAttemptState | undefined => (
  state.activationAttemptByDevice[deviceId]
);

const ensureAttempt = (state: PlanEngineState, deviceId: string): ActivationAttemptState => {
  const existing = getAttempt(state, deviceId);
  if (existing) return existing;
  const created: ActivationAttemptState = {};
  const attempts = state.activationAttemptByDevice;
  attempts[deviceId] = created;
  return created;
};

const pruneAttempt = (state: PlanEngineState, deviceId: string): void => {
  const entry = getAttempt(state, deviceId);
  if (entry && Object.keys(entry).length === 0) {
    const attempts = state.activationAttemptByDevice;
    delete attempts[deviceId];
  }
};

const getPenaltyLevel = (state: PlanEngineState, deviceId: string): number => (
  clampPenaltyLevel(getAttempt(state, deviceId)?.penaltyLevel)
);

const getAttemptStartedMs = (state: PlanEngineState, deviceId: string): number | null => {
  const startedMs = getAttempt(state, deviceId)?.startedMs;
  return isFiniteNumber(startedMs) ? startedMs : null;
};

const getAttemptSource = (state: PlanEngineState, deviceId: string): ActivationAttemptSource | null => {
  const source = getAttempt(state, deviceId)?.source;
  return source === 'pels_restore' || source === 'tracked_step_up' ? source : null;
};

const getLastSetbackMs = (state: PlanEngineState, deviceId: string): number | null => {
  const lastSetbackMs = getAttempt(state, deviceId)?.lastSetbackMs;
  return isFiniteNumber(lastSetbackMs) ? lastSetbackMs : null;
};

const closeAttempt = (state: PlanEngineState, deviceId: string): boolean => {
  const entry = getAttempt(state, deviceId);
  if (!entry) return false;

  let changed = false;
  if ('startedMs' in entry) {
    delete entry.startedMs;
    changed = true;
  }
  if ('source' in entry) {
    delete entry.source;
    changed = true;
  }
  if ('stickReached' in entry) {
    delete entry.stickReached;
    changed = true;
  }

  pruneAttempt(state, deviceId);
  return changed;
};

const setPenaltyLevel = (
  state: PlanEngineState,
  deviceId: string,
  nextPenaltyLevel: number,
): boolean => {
  const penaltyLevel = clampPenaltyLevel(nextPenaltyLevel);
  const currentPenaltyLevel = getPenaltyLevel(state, deviceId);
  if (penaltyLevel === currentPenaltyLevel) return false;

  if (penaltyLevel === 0) {
    const entry = getAttempt(state, deviceId);
    if (!entry) return false;
    delete entry.penaltyLevel;
    delete entry.lastSetbackMs;
    pruneAttempt(state, deviceId);
    return true;
  }

  ensureAttempt(state, deviceId).penaltyLevel = penaltyLevel;
  return true;
};

const updateLastSetbackMs = (state: PlanEngineState, deviceId: string, nowTs: number): boolean => {
  const entry = ensureAttempt(state, deviceId);
  if (entry.lastSetbackMs === nowTs) return false;
  entry.lastSetbackMs = nowTs;
  return true;
};

const hasStickReached = (attemptStartedMs: number, nowTs: number): boolean => (
  Math.max(0, nowTs - attemptStartedMs) >= ACTIVATION_BACKOFF_STICK_WINDOW_MS
);

const hasClearWindowReached = (attemptStartedMs: number, nowTs: number): boolean => (
  Math.max(0, nowTs - attemptStartedMs) >= ACTIVATION_BACKOFF_CLEAR_WINDOW_MS
);

const elapsedSinceAttemptMs = (attemptStartedMs: number, nowTs: number): number => (
  Math.max(0, nowTs - attemptStartedMs)
);

const remainingSeconds = (windowMs: number, elapsedMs: number): number => (
  Math.max(0, Math.ceil((windowMs - elapsedMs) / 1000))
);

export function getActivationPenaltyLevel(state: PlanEngineState, deviceId: string): number {
  return getPenaltyLevel(state, deviceId);
}

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

export function closeActivationAttemptForDevice(
  state: PlanEngineState,
  deviceId: string,
): boolean {
  return closeAttempt(state, deviceId);
}

export function syncActivationPenaltyState(params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
  observation?: ActivationBackoffObservation;
}): ActivationPenaltyInfo {
  const { state, deviceId, observation } = params;
  const nowTs = params.nowTs ?? Date.now();
  const penaltyLevel = getPenaltyLevel(state, deviceId);
  const attemptStartedMs = getAttemptStartedMs(state, deviceId);

  if (attemptStartedMs === null) {
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: null,
      stateChanged: false,
      source: null,
      transitions: [],
    };
  }

  const source = getAttemptSource(state, deviceId);
  const elapsedMs = elapsedSinceAttemptMs(attemptStartedMs, nowTs);

  if (isActivationObservationExplicitlyInactive(observation)) {
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: null,
      stateChanged: closeAttempt(state, deviceId),
      source,
      transitions: [{
        kind: 'attempt_closed_inactive',
        deviceId,
        source,
        penaltyLevel,
        elapsedMs,
        nowTs,
      }],
    };
  }

  const transitions: DeviceDiagnosticsBackoffTransition[] = [];
  let stateChanged = false;
  const stickReached = hasStickReached(attemptStartedMs, nowTs);

  if (stickReached) {
    const entry = ensureAttempt(state, deviceId);
    if (entry.stickReached !== true) {
      entry.stickReached = true;
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
  }

  if (hasClearWindowReached(attemptStartedMs, nowTs) && isActivationObservationActiveNow(observation)) {
    const previousPenaltyLevel = penaltyLevel;
    stateChanged = setPenaltyLevel(state, deviceId, 0) || stateChanged;
    stateChanged = closeAttempt(state, deviceId) || stateChanged;
    transitions.push({
      kind: 'penalty_cleared',
      deviceId,
      source,
      previousPenaltyLevel,
      elapsedMs,
      nowTs,
    });
    return {
      penaltyLevel: 0,
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
    stickRemainingSec: stickReached ? 0 : remainingSeconds(ACTIVATION_BACKOFF_STICK_WINDOW_MS, elapsedMs),
    clearRemainingSec: remainingSeconds(ACTIVATION_BACKOFF_CLEAR_WINDOW_MS, elapsedMs),
    stateChanged,
    source,
    transitions,
  };
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
  const { state, deviceId, source } = params;
  const nowTs = params.nowTs ?? Date.now();
  if (!deviceId || !Number.isFinite(nowTs) || getAttemptStartedMs(state, deviceId) !== null) {
    return { stateChanged: false, started: false };
  }

  const penaltyLevel = getPenaltyLevel(state, deviceId);
  const entry = ensureAttempt(state, deviceId);
  entry.startedMs = nowTs;
  entry.source = source;
  delete entry.stickReached;

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
  const { state, deviceId } = params;
  const nowTs = params.nowTs ?? Date.now();
  const attemptStartedMs = getAttemptStartedMs(state, deviceId);
  const penaltyLevel = getPenaltyLevel(state, deviceId);

  if (attemptStartedMs === null) {
    return { stateChanged: false, bumped: false, penaltyLevel };
  }

  const source = getAttemptSource(state, deviceId);
  const elapsedMs = elapsedSinceAttemptMs(attemptStartedMs, nowTs);
  const bumped = !hasStickReached(attemptStartedMs, nowTs);
  const nextPenaltyLevel = bumped ? clampPenaltyLevel(penaltyLevel + 1) : penaltyLevel;

  let stateChanged = closeAttempt(state, deviceId);
  if (bumped) {
    stateChanged = setPenaltyLevel(state, deviceId, nextPenaltyLevel) || stateChanged;
  }
  stateChanged = updateLastSetbackMs(state, deviceId, nowTs) || stateChanged;

  return {
    stateChanged,
    bumped,
    penaltyLevel: nextPenaltyLevel,
    transition: bumped
      ? {
        kind: 'setback_failed',
        deviceId,
        source,
        previousPenaltyLevel: penaltyLevel,
        penaltyLevel: nextPenaltyLevel,
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
  const penaltyLevel = clampPenaltyLevel(params.penaltyLevel);
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
  const { state, deviceId } = params;
  if (getPenaltyLevel(state, deviceId) <= 0) return null;

  const lastSetbackMs = getLastSetbackMs(state, deviceId);
  if (lastSetbackMs === null) return null;

  const nowTs = params.nowTs ?? Date.now();
  const remainingMs = ACTIVATION_SETBACK_RESTORE_BLOCK_MS - Math.max(0, nowTs - lastSetbackMs);
  return remainingMs > 0 ? remainingMs : null;
}
