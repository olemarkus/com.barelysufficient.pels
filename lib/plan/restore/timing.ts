import type { PlanEngineState } from '../planState';
import type { RestoreBackoff, RestoreCooldownState } from '../restoreBackoff';
import type { PlanContext, MeasuredPower } from '../planContext';
import { resolveSheddingClearThresholdKw } from '../powerLimitMath';
import type { RestoreDeps } from './types';
import type { DevicePlanDevice } from '../planTypes';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { MIN_ACTIVE_MEASURED_POWER_KW } from '../../observer/observedPower';
import { resolveReadingMeasuredAfterMs } from '../../power/heldReading';
import {
  RESTORE_COOLDOWN_MS,
  RESTORE_COOLDOWN_BACKOFF_MULTIPLIER,
  RESTORE_COOLDOWN_MAX_MS,
  RESTORE_STABLE_RESET_MS,
  SHED_COOLDOWN_MS,
} from '../planConstants';

export type RestoreTiming = RestoreCooldownState & {
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
};

/**
 * How old the whole-home reading behind this cycle's restore decisions is, for
 * a decision's log line. A rebuild no reading triggered (a settings change, a
 * timer) decides on the last accepted reading, which under the Flow power
 * source can be minutes old. Without a reading there is no age to state.
 */
export const buildRestoreEvidenceLogFields = (timing: RestoreTiming): { powerSampleAgeMs?: number } => (
  timing.measurementTs === null ? {} : { powerSampleAgeMs: Math.max(0, timing.nowTs - timing.measurementTs) }
);

const ceilSecondsOrNull = (ms: number | null): number | null =>
  (ms !== null ? Math.ceil(ms / 1000) : null);

export const buildRestoreTiming = (
  state: PlanEngineState,
  headroomRaw: number | null,
  deps: RestoreDeps,
  planDevices: readonly DevicePlanDevice[],
  nowTs: number,
): RestoreTiming => {
  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const cooldownState = resolveRestoreCooldown(state, nowTs);
  const sinceRestore = state.actuation.lastRestoreMs ? nowTs - state.actuation.lastRestoreMs : null;
  const cooldown = getShedCooldownState(state.restoreBackoff, nowTs, SHED_COOLDOWN_MS);
  const cooldownRemainingMs = cooldown.cooldownRemainingMs;
  const inCooldown = cooldown.inCooldown;
  const releasedByPower = cooldownState.restoreCooldownMs === RESTORE_COOLDOWN_MS
    && recentRestoresHavePowerEvidence(state, deps, planDevices, nowTs);
  const inRestoreCooldown = sinceRestore !== null && sinceRestore < cooldownState.restoreCooldownMs
    && !releasedByPower;
  const startupBlockRemainingMs = state.restoreBackoff.startupBlockRemainingMs(nowTs);
  const inStartupStabilization = startupBlockRemainingMs !== null && startupBlockRemainingMs > 0;
  const activeOvershoot = headroomRaw !== null && headroomRaw < 0;
  const restoreRemainingMs = inRestoreCooldown && sinceRestore !== null
    ? cooldownState.restoreCooldownMs - sinceRestore : 0;
  const restoreCooldownSeconds = sinceRestore !== null
    ? Math.ceil(restoreRemainingMs / 1000)
    : Math.ceil(cooldownState.restoreCooldownMs / 1000);
  const shedCooldownRemainingSec = ceilSecondsOrNull(cooldownRemainingMs);
  const shedCooldownStartedAtMs = cooldown.cooldownStartedAtMs;
  const shedCooldownTotalSec = ceilSecondsOrNull(cooldown.cooldownTotalMs);
  const restoreCooldownRemainingMs = sinceRestore !== null
    ? restoreRemainingMs
    : null;
  const restoreCooldownRemainingSec = ceilSecondsOrNull(restoreCooldownRemainingMs);
  const restoreCooldownStartedAtMs = state.actuation.lastRestoreMs;
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

/** How much of its expected draw a restored device must reach before the next increase is admitted. */
const STARTED_DRAW_FRACTION = 0.5;

/**
 * Pacing evidence, not command confirmation or attribution of the household
 * watts. Every restore still inside the ordinary window needs its device to
 * have started from idle after the restore and reached half its expected draw
 * before the time the whole-home reading's current value was measured after,
 * so that value includes the draw. A running device that steps up or has its
 * setpoint raised never started, so it keeps the timer, as does a restore whose
 * own step or target command is unconfirmed, or any in-flight or pending on/off
 * command.
 */
function recentRestoresHavePowerEvidence(
  state: PlanEngineState,
  deps: RestoreDeps,
  planDevices: readonly DevicePlanDevice[],
  nowTs: number,
): boolean {
  const measuredAfterMs = resolveReadingMeasuredAfterMs(deps.powerTracker);
  if (measuredAfterMs === null || state.actuation.hasInFlight()
    || planDevices.some((device) => device.binaryCommandPending)) return false;
  const { lastInstabilityMs } = state.restoreBackoff;
  const recentRestores = Object.entries(state.actuation.lastDeviceRestoreMs)
    .filter(([, restoredAtMs]) => nowTs - restoredAtMs < RESTORE_COOLDOWN_MS);
  return recentRestores.length > 0 && recentRestores.every(([deviceId, restoredAtMs]) => {
    const device = planDevices.find((candidate) => candidate.id === deviceId);
    return device !== undefined && device.stepCommandPending !== true
      && state.pendingTargetCommands[deviceId] === undefined
      && (lastInstabilityMs === null || lastInstabilityMs < restoredAtMs)
      && deps.hasStartedDrawingSince(deviceId, restoredAtMs, measuredAfterMs,
        Math.max(MIN_ACTIVE_MEASURED_POWER_KW, resolveExpectedDrawKw(device) * STARTED_DRAW_FRACTION));
  });
}

/** The step it runs at for a stepped load, its running draw otherwise. */
function resolveExpectedDrawKw(device: DevicePlanDevice): number {
  return isSteppedLoadDevice(device) ? device.planningPowerKw : device.expectedPowerKw;
}

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
 * protection. The measured capacity and grid axes must each clear the same
 * band the latch releases on (`resolveSheddingClearThresholdKw`); the exhausted
 * hour is its own explicit term (a silent meter never reaches this lane — the
 * silent-meter pass plans no restores at all).
 *
 * The capacity band matters because `softLimitSource` is instantaneous while
 * `sheddingActive` is a latch: a capacity-latched shed whose binding source
 * flips to `daily` mid-latch would otherwise open the lane while capacity
 * headroom sits inside the hysteresis band, and since the flat admission floor
 * went (2026-09-15) a budget-exempt candidate needing ~0.2 kW
 * (`computeRestoreBufferKw`) fits there — flapping at the very boundary the
 * latch exists to protect.
 */
export const shouldPlanBudgetExemptRestores = (
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  timing: Pick<RestoreTiming, 'inCooldown' | 'inRestoreCooldown' | 'inStartupStabilization'>,
  sheddingActive: boolean,
): boolean => (
  sheddingActive
  && context.softLimitSource === 'daily'
  && (power.capacityHeadroomKw === null || (
    power.capacityHeadroomKw > 0 && power.capacityHeadroomKw >= resolveSheddingClearThresholdKw(context)
  ))
  && (power.gridHeadroomKw === null || power.gridHeadroomKw >= resolveSheddingClearThresholdKw(context))
  && !state.capacityPeriodSpentFor(context)
  && !timing.inCooldown
  && !timing.inRestoreCooldown
  && !timing.inStartupStabilization
);

const resolveRestoreCooldown = (
  state: PlanEngineState,
  nowTs: number,
): RestoreCooldownState => {
  const lastRestoreMs = state.actuation.lastRestoreMs;
  const lastInstabilityMs = state.restoreBackoff.lastInstabilityMs;
  let { restoreCooldownMs, lastRestoreCooldownBumpMs } = state.restoreBackoff;
  // Nothing has destabilised this run, so nothing can reset or bump the
  // cooldown: carry the pair forward untouched.
  if (lastInstabilityMs === null) return { restoreCooldownMs, lastRestoreCooldownBumpMs };
  const instabilityAgeMs = nowTs - lastInstabilityMs;

  if (shouldResetRestoreCooldown(restoreCooldownMs, instabilityAgeMs)) {
    restoreCooldownMs = RESTORE_COOLDOWN_MS;
    lastRestoreCooldownBumpMs = lastInstabilityMs;
  }

  if (shouldBumpRestoreCooldown(lastRestoreMs, lastInstabilityMs, instabilityAgeMs, lastRestoreCooldownBumpMs)) {
    restoreCooldownMs = Math.min(
      restoreCooldownMs * RESTORE_COOLDOWN_BACKOFF_MULTIPLIER,
      RESTORE_COOLDOWN_MAX_MS,
    );
    lastRestoreCooldownBumpMs = lastInstabilityMs;
  }

  return { restoreCooldownMs, lastRestoreCooldownBumpMs };
};

const shouldResetRestoreCooldown = (
  restoreCooldownMs: number,
  instabilityAgeMs: number,
): boolean => (
  restoreCooldownMs !== RESTORE_COOLDOWN_MS && instabilityAgeMs >= RESTORE_STABLE_RESET_MS
);

/**
 * A restore that this instability followed, still inside the stable-reset
 * window, that this cooldown has not already been bumped for.
 */
const shouldBumpRestoreCooldown = (
  lastRestoreMs: number | null,
  lastInstabilityMs: number,
  instabilityAgeMs: number,
  lastRestoreCooldownBumpMs: number | null,
): boolean => {
  if (lastRestoreMs === null || lastInstabilityMs <= lastRestoreMs) return false;
  if (instabilityAgeMs >= RESTORE_STABLE_RESET_MS) return false;
  return lastRestoreCooldownBumpMs === null || lastRestoreCooldownBumpMs < lastInstabilityMs;
};

/**
 * The shed cooldown running off whichever of the back-off's two clocks fired
 * most recently, or no cooldown when neither has fired yet.
 */
export function getShedCooldownState(
  backoff: RestoreBackoff,
  nowTs: number,
  cooldownMs: number,
): {
  cooldownRemainingMs: number | null;
  cooldownStartedAtMs: number | null;
  cooldownTotalMs: number | null;
  inCooldown: boolean;
} {
  const candidates = [
    backoff.lastInstabilityMs === null
      ? null
      : { startedAtMs: backoff.lastInstabilityMs, elapsedMs: nowTs - backoff.lastInstabilityMs },
    backoff.lastRecoveryMs === null
      ? null
      : { startedAtMs: backoff.lastRecoveryMs, elapsedMs: nowTs - backoff.lastRecoveryMs },
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

/**
 * The countdown fields a timer hold reason carries, for the card to
 * interpolate: each present only when the timer reported it.
 */
export const buildCountdownTiming = (
  startedAtMs: number | null,
  totalSec: number | null,
) => ({
  ...(typeof startedAtMs === 'number' ? { countdownStartedAtMs: startedAtMs } : {}),
  ...(typeof totalSec === 'number' && totalSec > 0 ? { countdownTotalSec: totalSec } : {}),
});

/** A restore already admitted this cycle is the wait, when there is one. */
export const inCycleRestoreWait = (blocked: boolean): 'in_cycle_restore' | null => (
  blocked ? 'in_cycle_restore' : null
);

/** Other devices still recovering are the wait, when they are. */
export const otherRecoveryWait = (waiting: boolean): 'other_recovery' | null => (
  waiting ? 'other_recovery' : null
);

/**
 * The timer or wait holding a restore, or null. After startup stabilization and
 * the cooldowns, `waitingOn` names the one other cause a caller found: a restore
 * already admitted this cycle, or other devices still recovering.
 */
export function resolveCapacityRestoreBlockReason(
  timing: RestoreTiming,
  waitingOn: 'in_cycle_restore' | 'other_recovery' | null,
  showStartupStabilization: boolean,
): DeviceReason | null {
  const startupReason = resolveStartupStabilizationReason(timing, showStartupStabilization);
  if (startupReason !== null) return startupReason;

  const cooldownReason = resolveCapacityRestoreCooldownReason(timing);
  if (cooldownReason !== null) return cooldownReason;

  if (waitingOn === 'in_cycle_restore') {
    return {
      code: PLAN_REASON_CODES.cooldownRestore,
      remainingSec: timing.restoreCooldownSeconds,
      ...buildCountdownTiming(timing.nowTs, timing.restoreCooldownSeconds),
    };
  }
  if (waitingOn === 'other_recovery') {
    return { code: PLAN_REASON_CODES.waitingForOtherDevices };
  }
  return null;
}

function resolveStartupStabilizationReason(
  timing: RestoreTiming,
  showStartupStabilization: boolean,
): DeviceReason | null {
  if (!timing.inStartupStabilization) return null;
  return showStartupStabilization ? { code: PLAN_REASON_CODES.startupStabilization } : null;
}

function resolveCapacityRestoreCooldownReason(timing: RestoreTiming): DeviceReason | null {
  if (timing.activeOvershoot) return null;
  if (timing.inCooldown) return buildShedCooldownReason(timing);
  return timing.inRestoreCooldown ? buildRestoreCooldownReason(timing) : null;
}

/**
 * The shed cooldown as a hold reason, counting down to the end of the window
 * that follows the last shed or recovery. Shared by both hold ladders
 * (`resolveCapacityRestoreBlockReason` here, `resolveOffDeviceReason` in
 * `restore/devices.ts`).
 */
export function buildShedCooldownReason(timing: RestoreTiming): DeviceReason {
  return {
    code: PLAN_REASON_CODES.cooldownShedding,
    remainingSec: timing.shedCooldownRemainingSec ?? 0,
    ...buildCountdownTiming(timing.shedCooldownStartedAtMs, timing.shedCooldownTotalSec),
  };
}

/** The restore cooldown as a hold reason, counting down to the next resume. */
export function buildRestoreCooldownReason(timing: RestoreTiming): DeviceReason {
  return {
    code: PLAN_REASON_CODES.cooldownRestore,
    remainingSec: timing.restoreCooldownRemainingSec ?? 0,
    ...buildCountdownTiming(timing.restoreCooldownStartedAtMs, timing.restoreCooldownTotalSec),
  };
}

/**
 * Wait for a whole-home reading after the last restore (or this cycle's
 * admission). Elapsed time alone is not evidence of the added load.
 */
export function resolveMeterSettlingReason(
  timing: RestoreTiming,
  lastRestoreTs: number | null,
  restoredOneThisCycle = false,
): DeviceReason | null {
  const referenceRestoreTs = restoredOneThisCycle ? timing.nowTs : lastRestoreTs;
  if (referenceRestoreTs === null) return null;
  if (timing.measurementTs !== null && timing.measurementTs > referenceRestoreTs) return null;
  return { code: PLAN_REASON_CODES.meterSettling };
}
