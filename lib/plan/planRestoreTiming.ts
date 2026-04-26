import type { PlanEngineState } from './planState';
import type { PowerTrackerState } from '../core/powerTracker';
import {
  RESTORE_COOLDOWN_MS,
  RESTORE_COOLDOWN_BACKOFF_MULTIPLIER,
  RESTORE_COOLDOWN_MAX_MS,
  RESTORE_STABLE_RESET_MS,
  SHED_COOLDOWN_MS,
} from './planConstants';

export type RestoreTiming = {
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  inStartupStabilization: boolean;
  activeOvershoot: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs: number | null;
  shedCooldownTotalSec: number | null;
  restoreCooldownRemainingSec: number | null;
  restoreCooldownStartedAtMs: number | null;
  restoreCooldownTotalSec: number | null;
  startupStabilizationRemainingSec: number | null;
  inShedWindow: boolean;
  measurementTs: number | null;
  nowTs: number;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
};

type RestoreCooldownState = {
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
};

/* eslint-disable complexity -- restore timing combines independent cooldown windows. */
export const buildRestoreTiming = (
  state: PlanEngineState,
  headroomRaw: number,
  powerTracker: PowerTrackerState,
): RestoreTiming => {
  const nowTs = Date.now();
  const measurementTs = powerTracker.lastTimestamp ?? null;
  const cooldownState = resolveRestoreCooldown(state, nowTs);
  const sinceRestore = state.lastRestoreMs ? nowTs - state.lastRestoreMs : null;
  const cooldown = getShedCooldownState({
    lastInstabilityMs: state.lastInstabilityMs,
    lastRecoveryMs: state.lastRecoveryMs,
    nowTs,
    cooldownMs: SHED_COOLDOWN_MS,
  });
  const cooldownRemainingMs = cooldown.cooldownRemainingMs;
  const inCooldown = cooldown.inCooldown;
  const inRestoreCooldown = sinceRestore !== null && sinceRestore < cooldownState.restoreCooldownMs;
  const startupBlockRemainingMs = typeof state.startupRestoreBlockedUntilMs === 'number'
    ? Math.max(0, state.startupRestoreBlockedUntilMs - nowTs)
    : null;
  const inStartupStabilization = startupBlockRemainingMs !== null && startupBlockRemainingMs > 0;
  const activeOvershoot = headroomRaw < 0;
  const restoreCooldownSeconds = sinceRestore !== null
    ? Math.max(0, Math.ceil((cooldownState.restoreCooldownMs - sinceRestore) / 1000))
    : Math.ceil(cooldownState.restoreCooldownMs / 1000);
  const shedCooldownRemainingSec = cooldownRemainingMs !== null ? Math.ceil(cooldownRemainingMs / 1000) : null;
  const shedCooldownStartedAtMs = cooldown.cooldownStartedAtMs;
  const shedCooldownTotalSec = cooldown.cooldownTotalMs !== null
    ? Math.ceil(cooldown.cooldownTotalMs / 1000)
    : null;
  const restoreCooldownRemainingMs = sinceRestore !== null
    ? Math.max(0, cooldownState.restoreCooldownMs - sinceRestore)
    : null;
  const restoreCooldownRemainingSec = restoreCooldownRemainingMs !== null
    ? Math.ceil(restoreCooldownRemainingMs / 1000)
    : null;
  const restoreCooldownStartedAtMs = typeof state.lastRestoreMs === 'number' ? state.lastRestoreMs : null;
  const restoreCooldownTotalSec = Math.ceil(cooldownState.restoreCooldownMs / 1000);
  const startupStabilizationRemainingSec = startupBlockRemainingMs !== null
    ? Math.ceil(startupBlockRemainingMs / 1000)
    : null;
  const inShedWindow = inCooldown || activeOvershoot || inRestoreCooldown || inStartupStabilization;

  return {
    inCooldown,
    inRestoreCooldown,
    inStartupStabilization,
    activeOvershoot,
    restoreCooldownSeconds,
    shedCooldownRemainingSec,
    shedCooldownStartedAtMs,
    shedCooldownTotalSec,
    restoreCooldownRemainingSec,
    restoreCooldownStartedAtMs,
    restoreCooldownTotalSec,
    startupStabilizationRemainingSec,
    inShedWindow,
    measurementTs,
    nowTs,
    ...cooldownState,
  };
};
/* eslint-enable complexity */

export const shouldPlanRestores = (
  _headroomRaw: number,
  sheddingActive: boolean,
  timing: Pick<RestoreTiming, 'inCooldown' | 'inRestoreCooldown' | 'inStartupStabilization'>,
): boolean => (
  !sheddingActive
  && !timing.inCooldown
  && !timing.inRestoreCooldown
  && !timing.inStartupStabilization
);

const resolveRestoreCooldown = (
  state: PlanEngineState,
  nowTs: number,
): RestoreCooldownState => {
  const lastRestoreMs = state.lastRestoreMs;
  const lastInstabilityMs = typeof state.lastInstabilityMs === 'number' ? state.lastInstabilityMs : 0;
  const instabilityAgeMs = getInstabilityAgeMs(lastInstabilityMs, nowTs);

  let restoreCooldownMs = state.restoreCooldownMs ?? RESTORE_COOLDOWN_MS;
  let lastRestoreCooldownBumpMs = state.lastRestoreCooldownBumpMs ?? null;

  if (shouldResetRestoreCooldown(restoreCooldownMs, instabilityAgeMs)) {
    restoreCooldownMs = RESTORE_COOLDOWN_MS;
    lastRestoreCooldownBumpMs = lastInstabilityMs;
  }

  if (shouldBumpRestoreCooldown({
    lastRestoreMs,
    lastInstabilityMs,
    instabilityAgeMs,
    lastRestoreCooldownBumpMs,
  })) {
    restoreCooldownMs = Math.min(
      restoreCooldownMs * RESTORE_COOLDOWN_BACKOFF_MULTIPLIER,
      RESTORE_COOLDOWN_MAX_MS,
    );
    lastRestoreCooldownBumpMs = lastInstabilityMs;
  }

  return { restoreCooldownMs, lastRestoreCooldownBumpMs };
};

const getInstabilityAgeMs = (lastInstabilityMs: number, nowTs: number): number | null => {
  if (lastInstabilityMs <= 0) return null;
  return nowTs - lastInstabilityMs;
};

const shouldResetRestoreCooldown = (
  restoreCooldownMs: number,
  instabilityAgeMs: number | null,
): boolean => {
  if (instabilityAgeMs === null) return false;
  if (restoreCooldownMs === RESTORE_COOLDOWN_MS) return false;
  return instabilityAgeMs >= RESTORE_STABLE_RESET_MS;
};

const shouldBumpRestoreCooldown = (params: {
  lastRestoreMs: number | null;
  lastInstabilityMs: number;
  instabilityAgeMs: number | null;
  lastRestoreCooldownBumpMs: number | null;
}): boolean => {
  const {
    lastRestoreMs,
    lastInstabilityMs,
    instabilityAgeMs,
    lastRestoreCooldownBumpMs,
  } = params;
  if (lastRestoreMs === null || lastInstabilityMs <= 0) return false;
  if (lastInstabilityMs <= lastRestoreMs) return false;
  if (instabilityAgeMs === null || instabilityAgeMs >= RESTORE_STABLE_RESET_MS) return false;
  if (lastRestoreCooldownBumpMs !== null && lastRestoreCooldownBumpMs >= lastInstabilityMs) return false;
  return true;
};

export function getShedCooldownState(params: {
  lastInstabilityMs?: number | null;
  lastRecoveryMs?: number | null;
  nowTs?: number;
  cooldownMs?: number;
}): {
  cooldownRemainingMs: number | null;
  cooldownStartedAtMs: number | null;
  cooldownTotalMs: number | null;
  inCooldown: boolean;
} {
  const nowTs = params.nowTs ?? Date.now();
  const cooldownMs = params.cooldownMs ?? SHED_COOLDOWN_MS;
  const candidates = [
    typeof params.lastInstabilityMs === 'number'
      ? { startedAtMs: params.lastInstabilityMs, elapsedMs: nowTs - params.lastInstabilityMs }
      : null,
    typeof params.lastRecoveryMs === 'number'
      ? { startedAtMs: params.lastRecoveryMs, elapsedMs: nowTs - params.lastRecoveryMs }
      : null,
  ].filter((value) => value !== null);
  if (candidates.length === 0) {
    return {
      cooldownRemainingMs: null,
      cooldownStartedAtMs: null,
      cooldownTotalMs: null,
      inCooldown: false,
    };
  }
  let activeCandidate = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (candidate.elapsedMs < activeCandidate.elapsedMs) activeCandidate = candidate;
  }
  const cooldownRemainingMs = Math.max(0, cooldownMs - activeCandidate.elapsedMs);
  return {
    cooldownRemainingMs,
    cooldownStartedAtMs: activeCandidate.startedAtMs,
    cooldownTotalMs: cooldownMs,
    inCooldown: cooldownRemainingMs > 0,
  };
}

import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';

export type CapacityRestoreGateTiming = {
  activeOvershoot: boolean;
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  inStartupStabilization: boolean;
  measurementTs: number | null;
  nowTs: number;
  restoreCooldownSeconds: number;
  restoreCooldownMs: number;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
  restoreCooldownRemainingSec: number | null;
  restoreCooldownStartedAtMs?: number | null;
  restoreCooldownTotalSec?: number | null;
  startupStabilizationRemainingSec: number | null;
};

export type CapacityRestoreBlockReasonTiming = Pick<
  CapacityRestoreGateTiming,
  | 'activeOvershoot'
  | 'inCooldown'
  | 'inRestoreCooldown'
  | 'inStartupStabilization'
  | 'restoreCooldownSeconds'
  | 'shedCooldownRemainingSec'
  | 'restoreCooldownRemainingSec'
> & Partial<Pick<
  CapacityRestoreGateTiming,
  | 'nowTs'
  | 'restoreCooldownMs'
  | 'shedCooldownStartedAtMs'
  | 'shedCooldownTotalSec'
  | 'restoreCooldownStartedAtMs'
  | 'restoreCooldownTotalSec'
>>;

const buildCountdownTiming = (
  startedAtMs: number | null | undefined,
  totalSec: number | null | undefined,
) => ({
  ...(typeof startedAtMs === 'number' ? { countdownStartedAtMs: startedAtMs } : {}),
  ...(typeof totalSec === 'number' && totalSec > 0 ? { countdownTotalSec: totalSec } : {}),
});

type MeterSettlingTiming = Pick<
  CapacityRestoreGateTiming,
  'activeOvershoot' | 'measurementTs' | 'nowTs'
>;

export function resolveCapacityRestoreBlockReason(params: {
  timing: CapacityRestoreBlockReasonTiming;
  restoredOneThisCycle?: boolean;
  waitingForOtherRecovery?: boolean;
  useThrottleLabel?: boolean;
  showStartupStabilization?: boolean;
}): DeviceReason | null {
  const {
    timing,
    restoredOneThisCycle = false,
    waitingForOtherRecovery = false,
    useThrottleLabel = false,
    showStartupStabilization = true,
  } = params;

  const startupReason = resolveStartupStabilizationReason(timing, showStartupStabilization);
  if (startupReason !== null) return startupReason;

  const cooldownReason = resolveCapacityRestoreCooldownReason(timing);
  if (cooldownReason !== null) return cooldownReason;

  if (restoredOneThisCycle) {
    return useThrottleLabel
      ? { code: PLAN_REASON_CODES.restoreThrottled }
      : {
        code: PLAN_REASON_CODES.cooldownRestore,
        remainingSec: timing.restoreCooldownSeconds,
        ...buildCountdownTiming(timing.nowTs, timing.restoreCooldownSeconds),
      };
  }
  if (waitingForOtherRecovery) {
    return { code: PLAN_REASON_CODES.waitingForOtherDevices };
  }
  return null;
}

function resolveStartupStabilizationReason(
  timing: CapacityRestoreBlockReasonTiming,
  showStartupStabilization: boolean,
): DeviceReason | null {
  if (!timing.inStartupStabilization) return null;
  return showStartupStabilization ? { code: PLAN_REASON_CODES.startupStabilization } : null;
}

function resolveCapacityRestoreCooldownReason(timing: CapacityRestoreBlockReasonTiming): DeviceReason | null {
  if (timing.activeOvershoot) return null;
  if (timing.inCooldown) {
    return {
      code: PLAN_REASON_CODES.cooldownShedding,
      remainingSec: timing.shedCooldownRemainingSec ?? 0,
      ...buildCountdownTiming(timing.shedCooldownStartedAtMs, timing.shedCooldownTotalSec),
    };
  }
  if (timing.inRestoreCooldown) {
    return {
      code: PLAN_REASON_CODES.cooldownRestore,
      remainingSec: timing.restoreCooldownRemainingSec ?? 0,
      ...buildCountdownTiming(timing.restoreCooldownStartedAtMs, timing.restoreCooldownTotalSec),
    };
  }
  return null;
}

export function resolveMeterSettlingRemainingSec(params: {
  timing: MeterSettlingTiming;
  lastRestoreTs?: number | null;
  restoredOneThisCycle?: boolean;
}): number | null {
  const { timing, lastRestoreTs = null, restoredOneThisCycle = false } = params;
  if (timing.activeOvershoot) return null;
  const referenceRestoreTs = restoredOneThisCycle ? timing.nowTs : lastRestoreTs;
  if (typeof referenceRestoreTs !== 'number') return null;
  if (timing.measurementTs !== null && timing.measurementTs > referenceRestoreTs) return null;
  const remainingMs = (referenceRestoreTs + RESTORE_COOLDOWN_MS) - timing.nowTs;
  if (remainingMs <= 0) return null;
  return Math.ceil(remainingMs / 1000);
}

export function resolveMeterSettlingCountdownTiming(params: {
  timing: MeterSettlingTiming;
  lastRestoreTs?: number | null;
  restoredOneThisCycle?: boolean;
}): { countdownStartedAtMs: number; countdownTotalSec: number } | undefined {
  const { timing, lastRestoreTs = null, restoredOneThisCycle = false } = params;
  if (timing.activeOvershoot) return undefined;
  const referenceRestoreTs = restoredOneThisCycle ? timing.nowTs : lastRestoreTs;
  if (typeof referenceRestoreTs !== 'number') return undefined;
  if (timing.measurementTs !== null && timing.measurementTs > referenceRestoreTs) return undefined;
  return {
    countdownStartedAtMs: referenceRestoreTs,
    countdownTotalSec: Math.ceil(RESTORE_COOLDOWN_MS / 1000),
  };
}
