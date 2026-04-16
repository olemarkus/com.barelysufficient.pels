import type {
  ActivationAttemptState,
  ActivationAttemptSource,
  PlanEngineState,
} from './planState';
import type { DeviceDiagnosticsBackoffTransition } from '../diagnostics/deviceDiagnosticsService';
import { resolveEffectiveCurrentOn } from './planCurrentState';

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

const elapsedMs = (startedMs: number, nowTs: number): number => Math.max(0, nowTs - startedMs);

const hasStickReached = (attemptStartedMs: number, nowTs: number): boolean => (
  elapsedMs(attemptStartedMs, nowTs) >= ACTIVATION_BACKOFF_STICK_WINDOW_MS
);

const remainingSeconds = (remainingMs: number): number => Math.max(0, Math.ceil(remainingMs / 1000));

const getCooldownMsForPenaltyLevel = (penaltyLevel: number): number => {
  const clamped = clampPenaltyLevel(penaltyLevel);
  if (clamped <= 0) return 0;
  return Math.min(
    ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
    ACTIVATION_SETBACK_RESTORE_BLOCK_MS * (2 ** (clamped - 1)),
  );
};

const getClearRemainingSec = (
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): number | null => {
  const penaltyLevel = getPenaltyLevel(state, deviceId);
  if (penaltyLevel <= 0) return null;

  const lastSetbackMs = getLastSetbackMs(state, deviceId);
  if (lastSetbackMs === null) return null;

  const remainingMs = getCooldownMsForPenaltyLevel(penaltyLevel) - elapsedMs(lastSetbackMs, nowTs);
  return remainingMs > 0 ? remainingSeconds(remainingMs) : 0;
};

export function getActivationPenaltyLevel(state: PlanEngineState, deviceId: string): number {
  return getPenaltyLevel(state, deviceId);
}

export function isActivationObservationExplicitlyInactive(
  observation?: ActivationBackoffObservation,
): boolean {
  if (!observation) return false;
  if (observation.available === false) return true;
  if (resolveEffectiveCurrentOn(observation) === false) return true;
  if (observation.currentState === 'off' || observation.currentState === 'inactive') return true;
  return false;
}

export function isActivationObservationActiveNow(
  observation?: ActivationBackoffObservation,
): boolean {
  if (!observation) return false;
  if (observation.available === false) return false;
  if (resolveEffectiveCurrentOn(observation) === true) return true;
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
  const attemptStartedMs = getAttemptStartedMs(state, deviceId);
  const penaltyLevel = getPenaltyLevel(state, deviceId);

  if (attemptStartedMs === null) {
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: getClearRemainingSec(state, deviceId, nowTs),
      stateChanged: false,
      source: null,
      transitions: [],
    };
  }

  const source = getAttemptSource(state, deviceId);
  const elapsed = elapsedMs(attemptStartedMs, nowTs);

  if (isActivationObservationExplicitlyInactive(observation)) {
    return {
      penaltyLevel,
      attemptOpen: false,
      stickReached: false,
      stickRemainingSec: null,
      clearRemainingSec: getClearRemainingSec(state, deviceId, nowTs),
      stateChanged: closeAttempt(state, deviceId),
      source,
      transitions: [{
        kind: 'attempt_closed_inactive',
        deviceId,
        source,
        penaltyLevel,
        elapsedMs: elapsed,
        nowTs,
      }],
    };
  }

  const stickReached = hasStickReached(attemptStartedMs, nowTs);
  if (stickReached && isActivationObservationActiveNow(observation)) {
    const transitions: DeviceDiagnosticsBackoffTransition[] = [{
      kind: 'stick_reached',
      deviceId,
      source,
      penaltyLevel,
      elapsedMs: elapsed,
      nowTs,
    }];

    let stateChanged = closeAttempt(state, deviceId);
    if (penaltyLevel > 0) {
      stateChanged = setPenaltyLevel(state, deviceId, 0) || stateChanged;
      transitions.push({
        kind: 'penalty_cleared',
        deviceId,
        source,
        previousPenaltyLevel: penaltyLevel,
        elapsedMs: elapsed,
        nowTs,
      });
    }

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
    stickRemainingSec: stickReached ? 0 : remainingSeconds(ACTIVATION_BACKOFF_STICK_WINDOW_MS - elapsed),
    clearRemainingSec: getClearRemainingSec(state, deviceId, nowTs),
    stateChanged: false,
    source,
    transitions: [],
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
  const elapsed = elapsedMs(attemptStartedMs, nowTs);
  const failedBeforeStick = !hasStickReached(attemptStartedMs, nowTs);
  const nextPenaltyLevel = failedBeforeStick
    ? clampPenaltyLevel(penaltyLevel + 1)
    : Math.max(1, penaltyLevel);

  let stateChanged = closeAttempt(state, deviceId);
  stateChanged = setPenaltyLevel(state, deviceId, nextPenaltyLevel) || stateChanged;
  stateChanged = updateLastSetbackMs(state, deviceId, nowTs) || stateChanged;

  return {
    stateChanged,
    bumped: nextPenaltyLevel > penaltyLevel,
    penaltyLevel: nextPenaltyLevel,
    transition: failedBeforeStick
      ? {
        kind: 'setback_failed',
        deviceId,
        source,
        previousPenaltyLevel: penaltyLevel,
        penaltyLevel: nextPenaltyLevel,
        elapsedMs: elapsed,
        nowTs,
      }
      : {
        kind: 'setback_after_stick',
        deviceId,
        source,
        penaltyLevel: nextPenaltyLevel,
        elapsedMs: elapsed,
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
  const penaltyLevel = getPenaltyLevel(state, deviceId);
  if (penaltyLevel <= 0) return null;

  const lastSetbackMs = getLastSetbackMs(state, deviceId);
  if (lastSetbackMs === null) return null;

  const nowTs = params.nowTs ?? Date.now();
  const remainingMs = getCooldownMsForPenaltyLevel(penaltyLevel) - elapsedMs(lastSetbackMs, nowTs);
  return remainingMs > 0 ? remainingMs : null;
}
