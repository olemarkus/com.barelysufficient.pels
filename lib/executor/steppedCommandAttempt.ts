import type { SteppedLoadCommandStatus, SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import type { ExecutableSteppedLoadRestoreAttempt } from './executablePlan';

/**
 * Is one of THIS layer's own step commands still outstanding for the requested
 * step — awaiting telemetry confirmation, or sitting in retry backoff?
 *
 * The executor used to answer this by calling
 * `lib/plan/planSteppedRestorePending.ts:resolveSteppedRestoreAttemptState`, which
 * composes the planner's restore *reservation* (requested/baseline/delta kW, the
 * meter-settle countdown) with the command state. The executor discarded every one
 * of those planner numbers and read only `status` — so it was round-tripping
 * through the planner to be told about its own in-flight commands.
 *
 * `notes/AGENTS.md`: *"executor issues commands and handles pending/
 * materialization."* Nothing about a pending step command is planner business. See
 * `notes/state-management/actuation-clocks-and-settle.md`.
 *
 * Note what is NOT here: the meter-settle question (has a power reading arrived
 * since the write?). The executor never asked it — it called the planner helper
 * without a write clock, so that branch could not fire — and it is not this
 * predicate's job. It stays planner-side, where the restore reservation it
 * qualifies also lives.
 */
export const resolveSteppedCommandAttempt = (params: {
  /** The step this attempt is about. */
  requestedStepId: string | undefined;
  /**
   * The step the last command was issued for. An outstanding command for a
   * DIFFERENT step says nothing about this one, so the attempt is null.
   */
  lastDesiredStepId: string | undefined;
  steppedLoadProfile: SteppedLoadProfile;
  stepCommandPending: boolean | undefined;
  stepCommandStatus: SteppedLoadCommandStatus | undefined;
  nextStepCommandRetryAtMs: number | undefined;
  nowMs: number;
}): ExecutableSteppedLoadRestoreAttempt => {
  const {
    requestedStepId,
    lastDesiredStepId,
    steppedLoadProfile,
    stepCommandPending,
    stepCommandStatus,
    nextStepCommandRetryAtMs,
    nowMs,
  } = params;
  if (requestedStepId === undefined) return null;
  if (lastDesiredStepId !== requestedStepId) return null;
  // A step id the current profile no longer knows (driver swap remapped the
  // ladder mid-session) is not something to hold a command against.
  if (!getSteppedLoadStep(steppedLoadProfile, requestedStepId)) return null;

  if (stepCommandPending === true) {
    return { status: 'awaiting_confirmation', requestedStepId };
  }
  // `Number.isFinite`, not `typeof === 'number'` (which the planner helper used and
  // this inherited): `Infinity` passes a typeof check and makes `nowMs < deadline`
  // permanently true, suppressing this device's step commands forever. A deadline we
  // cannot compare against is not a backoff — fall through and let the command go.
  if (
    stepCommandStatus === 'stale'
    && nextStepCommandRetryAtMs !== undefined
    && Number.isFinite(nextStepCommandRetryAtMs)
    && nowMs < nextStepCommandRetryAtMs
  ) {
    return { status: 'retry_backoff', requestedStepId };
  }
  return null;
};
