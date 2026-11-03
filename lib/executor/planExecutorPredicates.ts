import type { PlannedDeviceExecution } from '../planContract/executionPlan';
import { hasPlannedStep } from '../planContract/executionPlan';
import type { PendingBinaryCommand } from '../ports/pendingBinaryCommand';
import type {
  ExecutableSteppedLoadCommandSession, ExecutableSteppedLoadDevice, ExecutableSteppedLoadIntent,
} from './executablePlan';
import { resolveSteppedCommandAttempt } from './steppedCommandAttempt';

export function resolveConfirmedBinaryCommandReasonCode(pending: PendingBinaryCommand): string {
  if (!pending.desired) return pending.lifecycleRelease ? 'lifecycle_release' : 'shedding';
  return pending.logContext === 'capacity_control_off' ? 'capacity_control_off_restore' : 'activation';
}

/**
 * `turnOnPending` is a pending turn-ON only, the question the plan device's
 * `binaryCommandPending` (`hasActiveTurnOn`) answered before the stable work
 * moved behind the execution contract. A pending turn-off does not hold the
 * binary operations back, and binary dispatch skips a matching command already
 * in flight on its own (`already_pending`, `binaryControlPreflight.ts`).
 */
export function hasStableDeviceActuation(
  device: PlannedDeviceExecution,
  session: ExecutableSteppedLoadCommandSession,
  turnOnPending: boolean,
  standingShed: boolean,
): boolean {
  const work = device.stableOperations;
  if (standingShed && work.includes('uncontrolled_restore')) return true;
  if (!turnOnPending && (work.includes('binary_release') || work.includes('binary_restore'))) return true;
  if (!hasPlannedStep(device.commands)) return false;
  const step = device.commands.steppedLoad;
  if (work.includes('initialize_step') && !session.command
    && session.reportedStepId === undefined && session.initializationAssumedStepId === undefined
    && !session.hasPriorStepCommand) return true;
  if (!work.includes('step_change')) return false;
  return resolveSteppedCommandAttempt(
    session.command, step.steppedLoadProfile, step.desired.plannedStepId, Date.now(),
  ) === null;
}

export function isSteppedLoadRestoreFromOff(
  intent: ExecutableSteppedLoadIntent | undefined,
  action: ExecutableSteppedLoadDevice | null,
): boolean {
  return Boolean(intent !== undefined && intent.plannedShedTarget === undefined && action?.current.on === false);
}
