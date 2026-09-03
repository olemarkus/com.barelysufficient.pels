import { describe, expect, it } from 'vitest';
import { shouldSkipUnrecoverableShortfallRebuild } from '../../lib/plan/rebuildScheduler/shortfallSuppression';
import type { PowerSampleRebuildState } from '../../lib/plan/rebuildScheduler/powerDriven';
import type { PowerRebuildSignal } from '../../lib/plan/rebuildScheduler/rebuildSignal';

const baseState: PowerSampleRebuildState = { lastMs: 1000 };

const signalWith = (overrides: Partial<PowerRebuildSignal> = {}): PowerRebuildSignal => ({
  currentPowerW: 5000,
  totalKw: 5,
  limitKw: 10,
  capacityPaceKw: 9,
  headroomKw: 4,
  shortfallThresholdKw: 10,
  isInShortfall: true,
  hardCapBreach: { breached: false, deficitKw: 0 },
  planConvergenceActive: false,
  unactionable: false,
  ...overrides,
});

describe('shouldSkipUnrecoverableShortfallRebuild', () => {
  it('suppresses the rebuild while the shortfall is unrecoverable and unchanged', () => {
    expect(shouldSkipUnrecoverableShortfallRebuild(signalWith(), baseState, true, false)).toBe(true);
  });

  // The max-interval escape: a stale "unactionable" summary must never suppress
  // rebuilds forever — a returned load (e.g. a non-measure_power binary device turned
  // on externally, so the invalidation latch never fires) has to be re-discovered.
  it('does NOT suppress once the max interval has elapsed', () => {
    expect(shouldSkipUnrecoverableShortfallRebuild(signalWith(), baseState, true, true)).toBe(false);
  });

  it('does not suppress when not in shortfall, latch-invalidated, or converging', () => {
    expect(
      shouldSkipUnrecoverableShortfallRebuild(signalWith({ isInShortfall: false }), baseState, true, false),
    ).toBe(false);
    expect(
      shouldSkipUnrecoverableShortfallRebuild(
        signalWith(),
        { ...baseState, shortfallSuppressionInvalidated: true },
        true,
        false,
      ),
    ).toBe(false);
    expect(
      shouldSkipUnrecoverableShortfallRebuild(signalWith({ planConvergenceActive: true }), baseState, true, false),
    ).toBe(false);
    expect(
      shouldSkipUnrecoverableShortfallRebuild(signalWith(), baseState, false, false),
    ).toBe(false);
  });
});
