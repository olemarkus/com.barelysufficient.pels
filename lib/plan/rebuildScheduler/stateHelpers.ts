import type { PowerSampleRebuildState } from './powerDriven';

export const resolvePendingPowerW = (
  snapshot: PowerSampleRebuildState,
): number | undefined => (
  typeof snapshot.pendingPowerW === 'number'
    ? snapshot.pendingPowerW
    : snapshot.lastRebuildPowerW
);

export const resolvePendingCapacityPaceKw = (
  snapshot: PowerSampleRebuildState,
): number | undefined => (
  typeof snapshot.pendingCapacityPaceKw === 'number'
    ? snapshot.pendingCapacityPaceKw
    : snapshot.lastCapacityPaceKw
);

export const resolvePendingOrInFlight = (
  snapshot: PowerSampleRebuildState,
): Promise<void | string> => (
  snapshot.pending ?? snapshot.inFlight ?? Promise.resolve()
);
