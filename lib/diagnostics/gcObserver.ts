/* eslint-disable functional/immutable-data -- Accumulates GC counters into a local window mutated only here. */
import { PerformanceObserver, constants } from 'node:perf_hooks';

type Bucket = { count: number; pauseMs: number };
type GcWindow = {
  scavenge: Bucket;
  major: Bucket;
  incremental: Bucket;
  weakCallbacks: Bucket;
};

const emptyBucket = (): Bucket => ({ count: 0, pauseMs: 0 });
const emptyWindow = (): GcWindow => ({
  scavenge: emptyBucket(),
  major: emptyBucket(),
  incremental: emptyBucket(),
  weakCallbacks: emptyBucket(),
});

let window: GcWindow = emptyWindow();
let observer: PerformanceObserver | undefined;

const observerKindBucket = (kind: number | undefined): Bucket | null => {
  if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) return window.major;
  if (kind === constants.NODE_PERFORMANCE_GC_MINOR) return window.scavenge;
  if (kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL) return window.incremental;
  if (kind === constants.NODE_PERFORMANCE_GC_WEAKCB) return window.weakCallbacks;
  return null;
};

/**
 * Starts a PerformanceObserver that counts GC events by kind into a
 * resettable in-process window. Defensive: returns a no-op stopper if the
 * platform doesn't support 'gc' entry types.
 */
export const startGcObserver = (): (() => void) => {
  if (observer) return () => undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const detail = (entry as { detail?: { kind?: number } }).detail;
        const bucket = observerKindBucket(detail?.kind);
        if (!bucket) continue;
        bucket.count++;
        bucket.pauseMs += entry.duration;
      }
    });
    observer.observe({ entryTypes: ['gc'], buffered: false });
    return () => {
      observer?.disconnect();
      observer = undefined;
    };
  } catch {
    observer = undefined;
    return () => undefined;
  }
};

const roundPause = (ms: number): number => Math.round(ms * 100) / 100;

/**
 * Returns the GC stats for the current window and resets the counters.
 */
export const drainGcWindow = (): {
  major: { count: number; pauseMs: number };
  scavenge: { count: number; pauseMs: number };
  incremental: { count: number; pauseMs: number };
  weakCallbacks: { count: number; pauseMs: number };
} => {
  const out = {
    major: { count: window.major.count, pauseMs: roundPause(window.major.pauseMs) },
    scavenge: { count: window.scavenge.count, pauseMs: roundPause(window.scavenge.pauseMs) },
    incremental: { count: window.incremental.count, pauseMs: roundPause(window.incremental.pauseMs) },
    weakCallbacks: { count: window.weakCallbacks.count, pauseMs: roundPause(window.weakCallbacks.pauseMs) },
  };
  window = emptyWindow();
  return out;
};
