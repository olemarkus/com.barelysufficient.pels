import type { PlanEngineState } from './planState';
import type { PowerTrackerState } from '../core/powerTracker';
import {
  RESTORE_COOLDOWN_MS,
  RESTORE_COOLDOWN_BACKOFF_MULTIPLIER,
  RESTORE_COOLDOWN_MAX_MS,
  RESTORE_STABLE_RESET_MS,
  SHED_COOLDOWN_MS,
} from './planConstants';
import { getShedCooldownState } from './planTiming';

export type RestoreTiming = {
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  inStartupStabilization: boolean;
  activeOvershoot: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  restoreCooldownRemainingSec: number | null;
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

export const buildRestoreTiming = (
  state: PlanEngineState,
  headroomRaw: number | null,
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
  const activeOvershoot = headroomRaw !== null && headroomRaw < 0;
  const restoreCooldownSeconds = sinceRestore !== null
    ? Math.max(0, Math.ceil((cooldownState.restoreCooldownMs - sinceRestore) / 1000))
    : Math.ceil(cooldownState.restoreCooldownMs / 1000);
  const shedCooldownRemainingSec = cooldownRemainingMs !== null ? Math.ceil(cooldownRemainingMs / 1000) : null;
  const restoreCooldownRemainingMs = sinceRestore !== null
    ? Math.max(0, cooldownState.restoreCooldownMs - sinceRestore)
    : null;
  const restoreCooldownRemainingSec = restoreCooldownRemainingMs !== null
    ? Math.ceil(restoreCooldownRemainingMs / 1000)
    : null;
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
    restoreCooldownRemainingSec,
    startupStabilizationRemainingSec,
    inShedWindow,
    measurementTs,
    nowTs,
    ...cooldownState,
  };
};

export const shouldPlanRestores = (
  headroomRaw: number | null,
  sheddingActive: boolean,
  timing: Pick<RestoreTiming, 'inCooldown' | 'inRestoreCooldown' | 'inStartupStabilization'>,
): boolean => (
  headroomRaw !== null
  && !sheddingActive
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
