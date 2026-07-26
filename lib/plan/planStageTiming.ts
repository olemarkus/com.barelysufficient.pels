/**
 * Per-stage timing + RSS accounting for the plan pipeline. Extracted from the
 * private `trackDuration`/`trackDurationAsync` methods `planBuilder.ts` used to
 * own, so the builder and the materialization stages share one implementation
 * instead of duplicating it. Behaviour is unchanged: same perf keys, same
 * `recordOpRssDelta` bracketing, same `finally` semantics on throw.
 */
import { addPerfDuration } from '../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../utils/opRssTracker';

/** Time a synchronous plan stage under `key` and record its RSS delta. */
export function trackPlanStage<T>(key: string, fn: () => T): T {
  const start = Date.now();
  const rssBefore = safeRss();
  try {
    return fn();
  } finally {
    addPerfDuration(key, Date.now() - start);
    recordOpRssDelta(key, rssBefore, safeRss());
  }
}

/** Time an asynchronous plan stage under `key` and record its RSS delta. */
export async function trackPlanStageAsync<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const rssBefore = safeRss();
  try {
    return await fn();
  } finally {
    addPerfDuration(key, Date.now() - start);
    recordOpRssDelta(key, rssBefore, safeRss());
  }
}
