import type { PlanCapacityStateSummary } from '../../power/capacityStateSummary';
import type { PowerSampleRebuildState } from './powerDriven';

export const clearShortfallSuppressionInvalidation = (
  snapshot: PowerSampleRebuildState,
): PowerSampleRebuildState => (
  snapshot.shortfallSuppressionInvalidated
    ? { ...snapshot, shortfallSuppressionInvalidated: false }
    : snapshot
);

export const resetShortfallSuppressionInvalidationWhenRecovered = (params: {
  state: PowerSampleRebuildState;
  isInShortfall: boolean;
  setState: (state: PowerSampleRebuildState) => void;
}): PowerSampleRebuildState => {
  const { state, isInShortfall, setState } = params;
  if (isInShortfall || !state.shortfallSuppressionInvalidated) return state;
  const nextState = clearShortfallSuppressionInvalidation(state);
  setState(nextState);
  return nextState;
};

export const shouldSkipShortfallRebuildFromPlanSummary = (params: {
  summary: PlanCapacityStateSummary;
  state: PowerSampleRebuildState;
}): boolean => {
  const { summary, state } = params;
  return (
    summary.remainingActionableControlledLoad === false
    && state.shortfallSuppressionInvalidated !== true
  );
};

export const shouldSkipUnrecoverableShortfallRebuild = (params: {
  skipWhileShortfallUnrecoverable: boolean;
  state: PowerSampleRebuildState;
  isInShortfall: boolean;
  planConvergenceActive?: boolean;
  maxIntervalExceeded?: boolean;
}): boolean => {
  const {
    skipWhileShortfallUnrecoverable,
    state,
    isInShortfall,
    planConvergenceActive,
    maxIntervalExceeded,
  } = params;
  return (
    skipWhileShortfallUnrecoverable
    && state.shortfallSuppressionInvalidated !== true
    && isInShortfall
    && planConvergenceActive !== true
    // Always yield a rebuild at least every max-interval so a stale "unactionable"
    // summary can never suppress rebuilds indefinitely (e.g. a device that returned
    // load without a measure_power signal would otherwise never be re-discovered).
    && maxIntervalExceeded !== true
  );
};
