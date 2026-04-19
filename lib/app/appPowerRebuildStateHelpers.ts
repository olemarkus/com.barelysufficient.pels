import type { PowerSampleRebuildState } from './appPowerRebuildScheduler';

export const resolvePendingPowerW = (
  snapshot: PowerSampleRebuildState,
): number | undefined => (
  typeof snapshot.pendingPowerW === 'number'
    ? snapshot.pendingPowerW
    : snapshot.lastRebuildPowerW
);

export const resolvePendingSoftLimitKw = (
  snapshot: PowerSampleRebuildState,
): number | undefined => (
  typeof snapshot.pendingSoftLimitKw === 'number'
    ? snapshot.pendingSoftLimitKw
    : snapshot.lastSoftLimitKw
);

export const resolvePendingOrInFlight = (
  snapshot: PowerSampleRebuildState,
): Promise<void | string> => (
  snapshot.pending ?? snapshot.inFlight ?? Promise.resolve()
);
