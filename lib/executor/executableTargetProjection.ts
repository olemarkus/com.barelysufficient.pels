import type {
  ExecutableObservedDeviceState,
  ExecutableTargetCommand,
  ExecutableTargetIntent,
  ExecutableTargetUpdate,
} from './executablePlan';

export function buildExecutableTargetUpdate(
  intent: ExecutableTargetIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): ExecutableTargetUpdate | null {
  if (!intent) return null;
  const command = buildExecutableTargetCommand(intent, observed);
  if (!command) return null;
  if (Object.is(command.observedValue, command.desired)) return null;

  return {
    ...command,
    // Planner-resolved, guarded in the diff domain the executor owns: the
    // plan's verdict is frozen at build time, so if the observation moved PAST
    // the desired value before apply, this write goes the other way — advancing
    // the restore clocks for it would delay legitimate restores by the backoff.
    // The guard compares only which side of desired the observation is on now
    // versus when the plan decided (no config, no policy, no direction — the
    // owner ruling stands); why the write is a restore was decided where the
    // setpoint was chosen.
    isRestoring: intent.recordRestoreOnTargetApply
      && typeof command.observedValue === 'number'
      && Math.sign(command.desired - command.observedValue) === Math.sign(command.desired - intent.restoreFromTarget),
  };
}

export function buildExecutableTargetCommand(
  intent: ExecutableTargetIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): ExecutableTargetCommand | null {
  if (!intent || !observed?.target) return null;
  return {
    deviceId: intent.deviceId,
    name: intent.name,
    desired: intent.desired,
    observedValue: observed.target.observedValue,
  };
}
