import type { DeferredObjectiveLiveCompletion } from '../../contracts/src/deferredObjectiveActivePlans';

export const isDeferredObjectiveLiveCompletion = (raw: unknown): raw is DeferredObjectiveLiveCompletion => {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return value.kind === 'unavailable' || value.kind === 'satisfied'
    || (value.kind === 'unmet'
      && (value.status === 'on_track' || value.status === 'at_risk' || value.status === 'cannot_meet'));
};

/** Resolve legacy absence or malformed external completion as explicit uncertainty. */
export const readDeferredObjectiveLiveCompletion = (raw: unknown): DeferredObjectiveLiveCompletion => (
  isDeferredObjectiveLiveCompletion(raw) ? raw : { kind: 'unavailable' }
);
