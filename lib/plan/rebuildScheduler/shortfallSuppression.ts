import type { PlanCapacityStateSummary } from '../../power/capacityStateSummary';
import type { PowerSampleRebuildState } from './powerDriven';
import type { PowerRebuildSignal } from './rebuildSignal';

export const clearShortfallSuppressionInvalidation = (
  snapshot: PowerSampleRebuildState,
): PowerSampleRebuildState => (
  snapshot.shortfallSuppressionInvalidated
    ? { ...snapshot, shortfallSuppressionInvalidated: false }
    : snapshot
);

export const resetShortfallSuppressionInvalidationWhenRecovered = (
  state: PowerSampleRebuildState,
  isInShortfall: boolean,
  setState: (next: PowerSampleRebuildState) => void,
): PowerSampleRebuildState => {
  if (isInShortfall || !state.shortfallSuppressionInvalidated) return state;
  const nextState = clearShortfallSuppressionInvalidation(state);
  setState(nextState);
  return nextState;
};

export const shouldSkipShortfallRebuildFromPlanSummary = (
  summary: PlanCapacityStateSummary,
  state: PowerSampleRebuildState,
): boolean => {
  return (
    summary.remainingActionableControlledLoad === false
    && state.shortfallSuppressionInvalidated !== true
  );
};

export const shouldSkipUnrecoverableShortfallRebuild = (
  signal: PowerRebuildSignal,
  state: PowerSampleRebuildState,
  skipWhileShortfallUnrecoverable: boolean,
  maxIntervalExceeded: boolean,
): boolean => {
  return (
    skipWhileShortfallUnrecoverable
    && state.shortfallSuppressionInvalidated !== true
    && signal.isInShortfall
    && !signal.planConvergenceActive
    // Always yield a rebuild at least every max-interval so a stale "unactionable"
    // summary can never suppress rebuilds indefinitely (e.g. a device that returned
    // load without a measure_power signal would otherwise never be re-discovered).
    && !maxIntervalExceeded
  );
};
