import type { DeferredObjectiveLifecycleEmitter } from '../objectives/deferredObjectives/lifecycleEmitter';
import { normalizeError } from '../utils/errorUtils';

/**
 * Default tick cadence for the smart-task lifecycle clock. Deadline /
 * hours-remaining / ended transitions are minute-ish granularity, so 30 s is
 * comfortably fine-grained while staying off the power path. Independent of
 * wall-clock arithmetic — deadlines are absolute timestamps, so DST 23/25-hour
 * days need no special handling here.
 */
const DEFERRED_OBJECTIVE_CLOCK_INTERVAL_MS = 30 * 1000;

export type DeferredObjectiveLifecycleClockDeps = {
  emitter: DeferredObjectiveLifecycleEmitter;
  getNowMs: () => number;
  error: (message: string, error: Error) => void;
  intervalMs?: number;
};

/**
 * Runs the smart-task lifecycle emission on its own clock instead of the
 * power-driven plan cycle — the fix for the `power_source = flow` lag where
 * deadline / ended / hours-remaining transitions stalled until the next power
 * event. Returns a stop handle for `onUninit`. Each tick is guarded so a
 * single failing evaluation never tears down the interval.
 *
 * See notes/state-management/deferred-objective-lifecycle-carveout.md.
 */
export const startDeferredObjectiveLifecycleClock = (
  deps: DeferredObjectiveLifecycleClockDeps,
): (() => void) => {
  const intervalMs = deps.intervalMs ?? DEFERRED_OBJECTIVE_CLOCK_INTERVAL_MS;
  const interval = setInterval(() => {
    try {
      deps.emitter.tick(deps.getNowMs());
    } catch (error: unknown) {
      deps.error('Failed to run smart-task lifecycle clock tick', normalizeError(error));
    }
  }, intervalMs);
  return () => {
    clearInterval(interval);
  };
};
