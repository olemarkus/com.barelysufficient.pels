import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import type { ExecutableSteppedCommandAttempt, ExecutableSteppedLoadCommandSession } from './executablePlan';
import { isSteppedLoadCommandInFlight } from './steppedCommandState';

/** Judge the executor's own outstanding command against the step this decision requests. */
export function resolveSteppedCommandAttempt(
  command: ExecutableSteppedLoadCommandSession['command'],
  profile: SteppedLoadProfile,
  requestedStepId: string | undefined,
  nowMs: number,
): ExecutableSteppedCommandAttempt {
  if (!command || requestedStepId === undefined || command.stepId !== requestedStepId) return null;
  if (!getSteppedLoadStep(profile, requestedStepId)) return null;
  // An acknowledged command is still awaiting its settled report; re-sending it adds nothing.
  if (isSteppedLoadCommandInFlight(command.status)) return { status: 'awaiting_confirmation', requestedStepId };
  if (command.status === 'stale' && command.nextRetryAtMs !== undefined
    && Number.isFinite(command.nextRetryAtMs) && nowMs < command.nextRetryAtMs) {
    return { status: 'retry_backoff', requestedStepId };
  }
  return null;
}
