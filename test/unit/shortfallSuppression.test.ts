import { describe, expect, it } from 'vitest';
import { shouldSkipUnrecoverableShortfallRebuild } from '../../lib/plan/rebuildScheduler/shortfallSuppression';
import type { PowerSampleRebuildState } from '../../lib/plan/rebuildScheduler/powerDriven';

const baseState: PowerSampleRebuildState = { lastMs: 1000 };

describe('shouldSkipUnrecoverableShortfallRebuild', () => {
  const skipParams = {
    skipWhileShortfallUnrecoverable: true,
    state: baseState,
    isInShortfall: true,
  };

  it('suppresses the rebuild while the shortfall is unrecoverable and unchanged', () => {
    expect(shouldSkipUnrecoverableShortfallRebuild(skipParams)).toBe(true);
  });

  // The max-interval escape: a stale "unactionable" summary must never suppress
  // rebuilds forever — a returned load (e.g. a non-measure_power binary device turned
  // on externally, so the invalidation latch never fires) has to be re-discovered.
  it('does NOT suppress once the max interval has elapsed', () => {
    expect(
      shouldSkipUnrecoverableShortfallRebuild({ ...skipParams, maxIntervalExceeded: true }),
    ).toBe(false);
  });

  it('still suppresses when the max interval has not elapsed', () => {
    expect(
      shouldSkipUnrecoverableShortfallRebuild({ ...skipParams, maxIntervalExceeded: false }),
    ).toBe(true);
  });

  it('does not suppress when not in shortfall, latch-invalidated, or converging', () => {
    expect(shouldSkipUnrecoverableShortfallRebuild({ ...skipParams, isInShortfall: false })).toBe(false);
    expect(
      shouldSkipUnrecoverableShortfallRebuild({
        ...skipParams,
        state: { ...baseState, shortfallSuppressionInvalidated: true },
      }),
    ).toBe(false);
    expect(
      shouldSkipUnrecoverableShortfallRebuild({ ...skipParams, planConvergenceActive: true }),
    ).toBe(false);
    expect(
      shouldSkipUnrecoverableShortfallRebuild({ ...skipParams, skipWhileShortfallUnrecoverable: false }),
    ).toBe(false);
  });
});
