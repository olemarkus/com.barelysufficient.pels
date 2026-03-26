export type CapacityRestoreGateTiming = {
  activeOvershoot: boolean;
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  restoreCooldownRemainingSec: number | null;
};

export function resolveCapacityRestoreBlockReason(params: {
  timing: CapacityRestoreGateTiming;
  restoredOneThisCycle?: boolean;
  waitingForOtherRecovery?: boolean;
  useThrottleLabel?: boolean;
}): string | null {
  const {
    timing,
    restoredOneThisCycle = false,
    waitingForOtherRecovery = false,
    useThrottleLabel = false,
  } = params;

  if (timing.inCooldown && !timing.activeOvershoot) {
    return `cooldown (shedding, ${timing.shedCooldownRemainingSec ?? 0}s remaining)`;
  }
  if (timing.inRestoreCooldown && !timing.activeOvershoot) {
    return `cooldown (restore, ${timing.restoreCooldownRemainingSec ?? 0}s remaining)`;
  }
  if (restoredOneThisCycle) {
    return useThrottleLabel
      ? 'restore throttled'
      : `cooldown (restore, ${timing.restoreCooldownSeconds}s remaining)`;
  }
  if (waitingForOtherRecovery) {
    return 'waiting for other devices to recover';
  }
  return null;
}
