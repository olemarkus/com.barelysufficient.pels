import { describe, expect, it } from 'vitest';
import {
  invalidateRebuildSuppressionForObservation,
} from '../../lib/plan/rebuildScheduler/observationSuppression';

const SUPPRESSED = {
  lastMs: 1_000,
  shortfallSuppressionInvalidated: false,
  tightNoopStreak: 3,
  backoffUntilMs: 120_000,
  mitigationHoldoffUntilMs: 20_000,
};

describe('invalidateRebuildSuppressionForObservation', () => {
  it('clears the two suppressions built from a now-stale "nothing is actionable" verdict', () => {
    expect(invalidateRebuildSuppressionForObservation(SUPPRESSED)).toMatchObject({
      shortfallSuppressionInvalidated: true,
      tightNoopStreak: 0,
      backoffUntilMs: undefined,
    });
  });

  // The asymmetry is the point, and it had no pin: `mitigationHoldoffUntilMs`
  // holds off after a rebuild that DID act, so the action can take effect before
  // PELS decides again — and an observation is frequently that action landing.
  // Clearing it would make PELS re-decide on its own command.
  it('leaves the post-mitigation holdoff alone', () => {
    expect(invalidateRebuildSuppressionForObservation(SUPPRESSED).mitigationHoldoffUntilMs)
      .toBe(20_000);
  });

  it('carries every unrelated field through untouched', () => {
    const withInFlight = { ...SUPPRESSED, lastRebuildPowerW: 4_000, pendingReason: 'power_delta' as const };
    expect(invalidateRebuildSuppressionForObservation(withInFlight)).toMatchObject({
      lastMs: 1_000,
      lastRebuildPowerW: 4_000,
      pendingReason: 'power_delta',
    });
  });

  // What lets the clear survive a rebuild that is already in flight — see
  // `observedDuringFlight` in `powerDrivenScheduling.ts`.
  it('advances the observation sequence, from absent and from a value', () => {
    expect(invalidateRebuildSuppressionForObservation({ lastMs: 0 }).observationSeq).toBe(1);
    expect(invalidateRebuildSuppressionForObservation({ lastMs: 0, observationSeq: 7 }).observationSeq)
      .toBe(8);
  });
});
