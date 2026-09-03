import type { PlanEngineState } from '../planState';
import type { SoftLimitSource } from '../planContext';
import type { PowerTrackerState } from '../../power/tracker';
import {
  RESTORE_COOLDOWN_MS,
  RESTORE_COOLDOWN_BACKOFF_MULTIPLIER,
  RESTORE_COOLDOWN_MAX_MS,
  RESTORE_STABLE_RESET_MS,
  SHED_COOLDOWN_MS,
} from '../planConstants';

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

const ceilSecondsOrNull = (ms: number | null): number | null =>
  (ms !== null ? Math.ceil(ms / 1000) : null);

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
  const shedCooldownRemainingSec = ceilSecondsOrNull(cooldownRemainingMs);
  const shedCooldownStartedAtMs = cooldown.cooldownStartedAtMs;
  const shedCooldownTotalSec = ceilSecondsOrNull(cooldown.cooldownTotalMs);
  const restoreCooldownRemainingMs = sinceRestore !== null
    ? Math.max(0, cooldownState.restoreCooldownMs - sinceRestore)
    : null;
  const restoreCooldownRemainingSec = ceilSecondsOrNull(restoreCooldownRemainingMs);
  const restoreCooldownStartedAtMs = typeof state.lastRestoreMs === 'number' ? state.lastRestoreMs : null;
  const restoreCooldownTotalSec = Math.ceil(cooldownState.restoreCooldownMs / 1000);
  const startupStabilizationRemainingSec = ceilSecondsOrNull(startupBlockRemainingMs);
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

export const shouldPlanRestores = (
  sheddingActive: boolean,
  timing: Pick<RestoreTiming, 'inCooldown' | 'inRestoreCooldown' | 'inStartupStabilization'>,
  hourlyBudgetExhausted: boolean,
): boolean => (
  !sheddingActive
  // An exhausted hour admits nothing before it rolls over — a FLAG, read
  // here, not a headroom forced negative upstream to make this gate fail.
  && !hourlyBudgetExhausted
  && !timing.inCooldown
  && !timing.inRestoreCooldown
  && !timing.inStartupStabilization
);

/**
 * Gate for the restricted budget-exempt restore lane
 * (`notes/safe-pace-two-constraints.md` § "Proposed model"): while shedding is
 * latched by a budget-driven overshoot, exempt candidates are still admitted —
 * against the capacity axis only, via the ledger's exempt routing.
 *
 * `softLimitSource === 'daily'` (not a headroom sign check) is the
 * discriminator on purpose: the latch persists through the clear-threshold
 * hysteresis band, so binding headroom may hover at/above zero while the lane
 * must keep running; and when the source is `capacity` the capacity axis IS
 * the binding axis, where running the lane would defeat the latch's flap
 * protection. `capacityHeadroomKw > 0` (strict) is the measured axis; the
 * exhausted hour is its own explicit term (a silent meter never reaches this
 * lane — the silent-meter pass plans no restores at all).
 *
 * Known accepted corner: `softLimitSource` is instantaneous while
 * `sheddingActive` is a latch, so a capacity-latched shed whose binding source
 * flips to `daily` mid-latch opens the lane while capacity headroom sits in
 * the hysteresis band. Bounded by the admission floor and the shed/restore
 * cooldowns; recording the latch cause would close it.
 */
export const shouldPlanBudgetExemptRestores = (params: {
  sheddingActive: boolean;
  softLimitSource: SoftLimitSource;
  capacityHeadroomKw: number;
  hourlyBudgetExhausted: boolean;
  timing: Pick<RestoreTiming, 'inCooldown' | 'inRestoreCooldown' | 'inStartupStabilization'>;
}): boolean => (
  params.sheddingActive
  && params.softLimitSource === 'daily'
  && params.capacityHeadroomKw > 0
  && !params.hourlyBudgetExhausted
  && !params.timing.inCooldown
  && !params.timing.inRestoreCooldown
  && !params.timing.inStartupStabilization
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
  let activeCandidate: { startedAtMs: number; elapsedMs: number } | undefined;
  for (const candidate of candidates) {
    if (!activeCandidate || candidate.elapsedMs < activeCandidate.elapsedMs) activeCandidate = candidate;
  }
  if (!activeCandidate) {
    return {
      cooldownRemainingMs: null,
      cooldownStartedAtMs: null,
      cooldownTotalMs: null,
      inCooldown: false,
    };
  }
  const cooldownRemainingMs = Math.max(0, cooldownMs - activeCandidate.elapsedMs);
  return {
    cooldownRemainingMs,
    cooldownStartedAtMs: activeCandidate.startedAtMs,
    cooldownTotalMs: cooldownMs,
    inCooldown: cooldownRemainingMs > 0,
  };
}

import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';

export type CapacityRestoreBlockReasonTiming = Pick<
  RestoreTiming,
  | 'activeOvershoot'
  | 'inCooldown'
  | 'inRestoreCooldown'
  | 'inStartupStabilization'
  | 'restoreCooldownSeconds'
  | 'shedCooldownRemainingSec'
  | 'restoreCooldownRemainingSec'
> & Partial<Pick<
  RestoreTiming,
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
  RestoreTiming,
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
