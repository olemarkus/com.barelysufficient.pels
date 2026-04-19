import type { PowerSampleRebuildState } from './appPowerRebuildScheduler';

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

export const shouldSkipUnrecoverableShortfallRebuild = (params: {
  skipWhileShortfallUnrecoverable: boolean;
  state: PowerSampleRebuildState;
  isInShortfall: boolean;
  planConvergenceActive?: boolean;
}): boolean => {
  const {
    skipWhileShortfallUnrecoverable,
    state,
    isInShortfall,
    planConvergenceActive,
  } = params;
  return (
    skipWhileShortfallUnrecoverable
    && state.shortfallSuppressionInvalidated !== true
    && isInShortfall
    && planConvergenceActive !== true
  );
};
