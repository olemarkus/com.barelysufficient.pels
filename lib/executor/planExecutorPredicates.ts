import type { PlannedDeviceExecution } from '../planContract/executionPlan';
import { hasPlannedStep } from '../planContract/executionPlan';
import type { PendingBinaryCommand } from '../observer/pendingBinaryCommandTypes';
import type {
  ExecutableSteppedLoadCommandSession, ExecutableSteppedLoadDevice, ExecutableSteppedLoadIntent,
} from './executablePlan';
import { resolveSteppedCommandAttempt } from './steppedCommandAttempt';

export function resolveConfirmedBinaryCommandReasonCode(pending: PendingBinaryCommand): string {
  if (!pending.desired) return pending.lifecycleRelease ? 'lifecycle_release' : 'shedding';
  return pending.logContext === 'capacity_control_off' ? 'capacity_control_off_restore' : 'activation';
}

export function hasStableDeviceActuation(
  device: PlannedDeviceExecution,
  session: ExecutableSteppedLoadCommandSession,
  binaryPending: boolean,
  standingShed: boolean,
): boolean {
  const work = device.stableOperations;
  if (standingShed && work.includes('uncontrolled_restore')) return true;
  if (!binaryPending && (work.includes('binary_release') || work.includes('binary_restore'))) return true;
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
