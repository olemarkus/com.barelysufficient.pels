import type {
  ActivationAttemptState,
  ActivationAttemptSource,
  PlanEngineState,
} from './planState';
import type { DeviceDiagnosticsBackoffTransition } from '../diagnostics/deviceDiagnosticsService';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import { OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS } from './planConstants';

export type { ActivationAttemptSource } from './planState';

export const ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS = OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS;
export const ACTIVATION_BACKOFF_CLEAR_WINDOW_MS = 30 * 60 * 1000;
export const ACTIVATION_BACKOFF_MAX_LEVEL = 4;
export const ACTIVATION_SETBACK_RESTORE_BLOCK_MS = 10 * 60 * 1000;

export type ActivationBackoffObservation = {
  available?: boolean;
  currentOn: boolean;
  currentState?: string;
  measuredPowerKw?: number;
};

export type ActivationPenaltyInfo = {
  penaltyLevel: number;
  attemptOpen: boolean;
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

const hasAttributionWindowExpired = (attemptStartedMs: number, nowTs: number): boolean => (
  elapsedMs(attemptStartedMs, nowTs) >= ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS
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

type CloseActivationAttemptKind = 'inactive' | 'shed' | 'quiet';

const closeActivationAttempt = (params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
  kind: CloseActivationAttemptKind;
}): {
  stateChanged: boolean;
  transition?: DeviceDiagnosticsBackoffTransition;
} => {
  const { state, deviceId, kind } = params;
  const attemptStartedMs = getAttemptStartedMs(state, deviceId);
  if (attemptStartedMs === null) {
    return { stateChanged: false };
  }

  const nowTs = params.nowTs ?? Date.now();
  const source = getAttemptSource(state, deviceId);
  const penaltyLevel = getPenaltyLevel(state, deviceId);
  const elapsed = elapsedMs(attemptStartedMs, nowTs);
  const stateChanged = closeAttempt(state, deviceId);
  if (!stateChanged || kind === 'quiet') {
    return { stateChanged };
  }

  return {
    stateChanged,
    transition: kind === 'inactive'
      ? {
        kind: 'attempt_closed_inactive',
        deviceId,
        source,
        penaltyLevel,
        elapsedMs: elapsed,
        nowTs,
      }
      : {
        kind: 'attempt_closed_by_shed',
        deviceId,
        source,
        penaltyLevel,
        elapsedMs: elapsed,
        nowTs,
      },
  };
};

export function closeActivationAttemptForDevice(
  state: PlanEngineState,
  deviceId: string,
): boolean {
  return closeActivationAttempt({ state, deviceId, kind: 'quiet' }).stateChanged;
}

export function closeActivationAttemptForShed(params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs?: number;
}): {
  stateChanged: boolean;
  transition?: DeviceDiagnosticsBackoffTransition;
} {
  return closeActivationAttempt({
    state: params.state,
    deviceId: params.deviceId,
    nowTs: params.nowTs,
    kind: 'shed',
  });
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
      clearRemainingSec: getClearRemainingSec(state, deviceId, nowTs),
      stateChanged: false,
      source: null,
      transitions: [],
    };
  }

  const source = getAttemptSource(state, deviceId);

  if (isActivationObservationExplicitlyInactive(observation)) {
    const closeResult = closeActivationAttempt({
      state,
      deviceId,
      nowTs,
      kind: 'inactive',
    });
    return {
      penaltyLevel,
      attemptOpen: false,
      clearRemainingSec: getClearRemainingSec(state, deviceId, nowTs),
      stateChanged: closeResult.stateChanged,
      source,
      transitions: closeResult.transition ? [closeResult.transition] : [],
    };
  }

  if (hasAttributionWindowExpired(attemptStartedMs, nowTs)) {
    const closeResult = closeActivationAttempt({
      state,
      deviceId,
      nowTs,
      kind: 'quiet',
    });
    return {
      penaltyLevel,
      attemptOpen: false,
      clearRemainingSec: getClearRemainingSec(state, deviceId, nowTs),
      stateChanged: closeResult.stateChanged,
      source,
      transitions: [],
    };
  }

  return {
    penaltyLevel,
    attemptOpen: true,
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
  if (hasAttributionWindowExpired(attemptStartedMs, nowTs)) {
    return {
      stateChanged: closeAttempt(state, deviceId),
      bumped: false,
      penaltyLevel,
    };
  }
  const nextPenaltyLevel = clampPenaltyLevel(penaltyLevel + 1);

  let stateChanged = closeAttempt(state, deviceId);
  stateChanged = setPenaltyLevel(state, deviceId, nextPenaltyLevel) || stateChanged;
  stateChanged = updateLastSetbackMs(state, deviceId, nowTs) || stateChanged;

  return {
    stateChanged,
    bumped: nextPenaltyLevel > penaltyLevel,
    penaltyLevel: nextPenaltyLevel,
    transition: {
      kind: 'setback_failed',
      deviceId,
      source,
      previousPenaltyLevel: penaltyLevel,
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
