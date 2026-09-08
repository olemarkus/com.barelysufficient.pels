import type { SteppedLoadProfile } from '../../../packages/contracts/src/types';
import type {
  ActivationAttempt,
  ActivationAttemptSource,
  ActivationPenalty,
  PlanEngineState,
} from '../planState';
import type { DeviceDiagnosticsBackoffTransition } from '../../diagnostics/deviceDiagnosticsService';
import { isActivelyDrawing } from '../../observer/observedPower';
import { OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS } from '../planConstants';
import { isSteppedDeviceAtActiveStep, isSteppedDeviceAtOffStep } from '../../utils/deviceControlProfiles';
import { isBinaryPlanDevice } from '../planBinaryDevice';

export type { ActivationAttemptSource } from '../planState';

export const ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS = OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS;
/**
 * How old an attempt must be before an "off" reading is allowed to close it as
 * `inactive`.
 *
 * The post-actuation snapshot refresh runs 5 s after a restore, which is far
 * sooner than a device can be seen drawing — an EV charger starts at p50 ~30 s.
 * Reading zero draw at 5 s closed the attempt immediately, which stranded the
 * attribution window: the overshoot the restore actually caused arrived after
 * the attempt was already gone, so it was never attributed and the backoff
 * ladder never learned. In production 61 of 63 inactive closes fired under 10 s.
 *
 * Below this age an off reading is pre-command evidence, not a failed
 * activation. Kept strictly below ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS so
 * this floor can never swallow the attribution window: an attempt that no
 * inactive observation closes is still closed by the expiry branch, so raising
 * the floor cannot leak one. That inequality is pinned by a unit test.
 *
 * Note the branch ordering this does NOT change: `syncActivationPenaltyState`
 * tests inactive before expiry, so an inactive observation arriving at or after
 * the attribution window closes as `inactive` (penalty preserved) rather than
 * taking the `quiet` expiry path (which can clear it). That precedence predates
 * this floor and is pinned below; whether that late inactive observation should
 * preserve the penalty at all, rather than expiring as quiet, is still an open
 * question.
 */
export const ACTIVATION_INACTIVE_MIN_ELAPSED_MS = 60 * 1000;
export const ACTIVATION_SETBACK_RESTORE_BLOCK_MS = 5 * 60 * 1000;
export const ACTIVATION_BACKOFF_CLEAR_WINDOW_MS = ACTIVATION_SETBACK_RESTORE_BLOCK_MS;
export const ACTIVATION_BACKOFF_MAX_LEVEL = 4;

/**
 * What the activation in/active reads read off a device. Every device that
 * reaches them — a plan device, a headroom-card snapshot view — carries the
 * producer-resolved reachability and draw. The other three are the device-kind
 * discriminants: `currentOn` is present iff binary (the on/off truth); a
 * step-only stepper carries no `currentOn` and is read from its step axis; a
 * device with neither is read from the producer-resolved state label.
 */
export type ActivationBackoffObservation = {
  available: boolean;
  currentDrawKw: number;
  currentOn?: boolean;
  currentState?: string;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

export type ActivationPenaltyInfo = {
  penaltyLevel: number;
  attemptOpen: boolean;
  stateChanged: boolean;
  transition: DeviceDiagnosticsBackoffTransition | null;
};

/** The restore block a fresh setback imposes, while it lasts. */
export type ActivationRestoreBlock = {
  remainingMs: number;
  countdownStartedAtMs: number;
  countdownTotalSec: number;
};

const getAttempt = (state: PlanEngineState, deviceId: string): ActivationAttempt | undefined => (
  state.activationAttemptByDevice[deviceId]
);

const getPenalty = (state: PlanEngineState, deviceId: string): ActivationPenalty | undefined => (
  state.activationPenaltyByDevice[deviceId]
);

const getPenaltyLevel = (state: PlanEngineState, deviceId: string): number => (
  getPenalty(state, deviceId)?.level ?? 0
);

const closeAttempt = (state: PlanEngineState, deviceId: string): boolean => {
  const attempts = state.activationAttemptByDevice;
  if (!(deviceId in attempts)) return false;
  delete attempts[deviceId];
  return true;
};

const clearPenalty = (state: PlanEngineState, deviceId: string): void => {
  const penalties = state.activationPenaltyByDevice;
  delete penalties[deviceId];
};

const setPenalty = (state: PlanEngineState, deviceId: string, penalty: ActivationPenalty): void => {
  const penalties = state.activationPenaltyByDevice;
  penalties[deviceId] = penalty;
};

const openAttempt = (state: PlanEngineState, deviceId: string, attempt: ActivationAttempt): void => {
  const attempts = state.activationAttemptByDevice;
  attempts[deviceId] = attempt;
};

const elapsedMs = (startedMs: number, nowTs: number): number => Math.max(0, nowTs - startedMs);

const hasAttributionWindowExpired = (attemptStartedMs: number, nowTs: number): boolean => (
  elapsedMs(attemptStartedMs, nowTs) >= ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS
);

/**
 * An attempt closes as `inactive` only once it is old enough that an off
 * reading could have seen the command land — see
 * ACTIVATION_INACTIVE_MIN_ELAPSED_MS. Uniform across device classes on purpose:
 * the rule is about how stale the evidence is, not about which device produced
 * it, and admission must not branch on device class.
 */
const shouldCloseAttemptAsInactive = (
  observation: ActivationBackoffObservation,
  attemptStartedMs: number,
  nowTs: number,
): boolean => (
  isActivationObservationExplicitlyInactive(observation)
  && elapsedMs(attemptStartedMs, nowTs) >= ACTIVATION_INACTIVE_MIN_ELAPSED_MS
);

export function getActivationPenaltyLevel(state: PlanEngineState, deviceId: string): number {
  return getPenaltyLevel(state, deviceId);
}

export function isActivationObservationExplicitlyInactive(
  observation: ActivationBackoffObservation,
): boolean {
  if (!observation.available) return true;
  // `currentOn === false` is a binary device confirmed off. A step-only stepper
  // (no binary handle, so `currentOn === undefined`) is off when parked at its off
  // step — read that from the step axis, or from the producer-resolved step label
  // `currentState` for a device that carries neither.
  if (isBinaryPlanDevice(observation)) return !observation.currentOn;
  return isSteppedDeviceAtOffStep(observation) || observation.currentState === 'off';
}

export function isActivationObservationActiveNow(
  observation: ActivationBackoffObservation,
): boolean {
  if (!observation.available) return false;
  if (isBinaryPlanDevice(observation) && observation.currentOn) return true;
  // Step-only stepper at an active step is on regardless of measurement (no binary
  // handle to read) — from the step axis, or the `currentState` label for a device
  // that carries neither; binary devices keep their measured-draw fallback.
  if (!isBinaryPlanDevice(observation)
    && (isSteppedDeviceAtActiveStep(observation) || observation.currentState === 'on')) return true;
  return isActivelyDrawing(observation);
}

const closeAttemptWithTransition = (
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
  kind: 'attempt_closed_inactive' | 'attempt_closed_by_shed',
): DeviceDiagnosticsBackoffTransition | null => {
  const attempt = getAttempt(state, deviceId);
  if (!attempt) return null;
  closeAttempt(state, deviceId);
  return {
    kind,
    deviceId,
    source: attempt.source,
    penaltyLevel: getPenaltyLevel(state, deviceId),
    elapsedMs: elapsedMs(attempt.startedMs, nowTs),
    nowTs,
  };
};

/** Close a device's open attempt without a diagnostics transition (it left the snapshot). */
export function closeActivationAttemptForDevice(
  state: PlanEngineState,
  deviceId: string,
): boolean {
  return closeAttempt(state, deviceId);
}

/** Close a device's open attempt because PELS shed it. Null when none was open. */
export function closeActivationAttemptForShed(
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): DeviceDiagnosticsBackoffTransition | null {
  return closeAttemptWithTransition(state, deviceId, nowTs, 'attempt_closed_by_shed');
}

export function syncActivationPenaltyState(
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
  observation: ActivationBackoffObservation,
): ActivationPenaltyInfo {
  const attempt = getAttempt(state, deviceId);
  const penaltyLevel = getPenaltyLevel(state, deviceId);

  if (!attempt) {
    return { penaltyLevel, attemptOpen: false, stateChanged: false, transition: null };
  }

  if (shouldCloseAttemptAsInactive(observation, attempt.startedMs, nowTs)) {
    return {
      penaltyLevel,
      attemptOpen: false,
      stateChanged: true,
      transition: closeAttemptWithTransition(state, deviceId, nowTs, 'attempt_closed_inactive'),
    };
  }

  if (hasAttributionWindowExpired(attempt.startedMs, nowTs)) {
    // The full attribution window elapsed without an overshoot being attributed
    // back to this device. Clear the accumulated penalty iff at least one clean
    // whole-home sample arrived during the window — that's the positive
    // evidence the cautious admission held: the household was actually
    // measured to be within budget while this device was admitted at the
    // inflated bar. Without a clean sample, "no overshoot attributed" could
    // just mean no cycle in the window measured the household within its limits
    // — absence of attribution is not evidence of capacity compliance.
    //
    // We deliberately do NOT also require evidence of device-side load draw.
    // The penalty exists to learn about household-level overshoot risk, not
    // to audit device command success. A device that was admitted and chose
    // not to draw (legitimate-zero, e.g. heater at setpoint) is still a
    // successful exercise of the cautious admission as long as the household
    // stayed safe through the window.
    closeAttempt(state, deviceId);
    if (!attempt.cleanWholeHomeSampleSeen || penaltyLevel === 0) {
      return { penaltyLevel, attemptOpen: false, stateChanged: true, transition: null };
    }
    clearPenalty(state, deviceId);
    return {
      penaltyLevel: 0,
      attemptOpen: false,
      stateChanged: true,
      transition: {
        kind: 'attempt_closed_by_admission',
        deviceId,
        source: attempt.source,
        previousPenaltyLevel: penaltyLevel,
        penaltyLevel: 0,
        elapsedMs: elapsedMs(attempt.startedMs, nowTs),
        nowTs,
      },
    };
  }

  return { penaltyLevel, attemptOpen: true, stateChanged: false, transition: null };
}

/**
 * A clean whole-home sample — the house measured under its pace, the hour not
 * spent — stamped at `sampleAtMs`. It counts for a restore attempt it falls
 * inside of: the evidence `syncActivationPenaltyState`'s window-expiry branch
 * reads to decide the cautious admission proved itself. Tracked step-ups earn
 * no release this way. Answers whether the attempt changed.
 */
export function recordCleanWholeHomeSample(
  state: PlanEngineState,
  deviceId: string,
  sampleAtMs: number,
): boolean {
  const attempt = getAttempt(state, deviceId);
  if (
    !attempt
    || attempt.source !== 'pels_restore'
    || attempt.cleanWholeHomeSampleSeen
    || sampleAtMs <= attempt.startedMs
    || hasAttributionWindowExpired(attempt.startedMs, sampleAtMs)
  ) return false;
  attempt.cleanWholeHomeSampleSeen = true;
  return true;
}

/** Open an attempt for a device with none open. Null when one is already open. */
export function recordActivationAttemptStart(
  state: PlanEngineState,
  deviceId: string,
  source: ActivationAttemptSource,
  nowTs: number,
): DeviceDiagnosticsBackoffTransition | null {
  if (getAttempt(state, deviceId)) return null;
  openAttempt(state, deviceId, { startedMs: nowTs, source, cleanWholeHomeSampleSeen: false });
  return {
    kind: 'attempt_started',
    deviceId,
    source,
    penaltyLevel: getPenaltyLevel(state, deviceId),
    nowTs,
  };
}

export type ActivationSetbackResult = {
  bumped: boolean;
  penaltyLevel: number;
  transition: DeviceDiagnosticsBackoffTransition | null;
};

export function recordActivationSetback(
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): ActivationSetbackResult {
  const attempt = getAttempt(state, deviceId);
  const penaltyLevel = getPenaltyLevel(state, deviceId);
  if (!attempt) return { bumped: false, penaltyLevel, transition: null };

  closeAttempt(state, deviceId);
  if (hasAttributionWindowExpired(attempt.startedMs, nowTs)) {
    return { bumped: false, penaltyLevel, transition: null };
  }
  const nextPenaltyLevel = Math.min(ACTIVATION_BACKOFF_MAX_LEVEL, penaltyLevel + 1);
  setPenalty(state, deviceId, { level: nextPenaltyLevel, lastSetbackMs: nowTs });
  return {
    bumped: nextPenaltyLevel > penaltyLevel,
    penaltyLevel: nextPenaltyLevel,
    transition: {
      kind: 'setback_failed',
      deviceId,
      source: attempt.source,
      previousPenaltyLevel: penaltyLevel,
      penaltyLevel: nextPenaltyLevel,
      elapsedMs: elapsedMs(attempt.startedMs, nowTs),
      nowTs,
    },
  };
}

export function applyActivationPenalty(
  baseRequiredKw: number,
  penaltyLevel: number,
): { requiredKwWithPenalty: number; penaltyExtraKw: number } {
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

/** The restore block a device's last setback still imposes at `nowTs`, or null once it lapsed. */
export function resolveActivationRestoreBlock(
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): ActivationRestoreBlock | null {
  const penalty = getPenalty(state, deviceId);
  if (!penalty) return null;
  const remainingMs = ACTIVATION_SETBACK_RESTORE_BLOCK_MS - elapsedMs(penalty.lastSetbackMs, nowTs);
  if (remainingMs <= 0) return null;
  return {
    remainingMs,
    countdownStartedAtMs: penalty.lastSetbackMs,
    countdownTotalSec: Math.ceil(ACTIVATION_SETBACK_RESTORE_BLOCK_MS / 1000),
  };
}
