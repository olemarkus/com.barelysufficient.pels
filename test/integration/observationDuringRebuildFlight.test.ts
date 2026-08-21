/**
 * The race that decides whether an observation has any effect at all.
 *
 * With the device-observation rebuild trigger gone, an observation's ONLY
 * remaining influence on the planner is clearing the rebuild suppressions so the
 * next reading is not throttled away (`lib/plan/rebuildScheduler/observationSuppression.ts`).
 *
 * A rebuild reads its devices at the start of its body and finishes hundreds of
 * milliseconds to seconds later. An observation landing inside that window is
 * about a house the in-flight rebuild never saw — so that rebuild's
 * "nothing is actionable" verdict must not be allowed to install a backoff or
 * clear the latch. At a ~1.4 s build against a 10 s poll this is a routine race.
 */
import { describe, expect, it } from 'vitest';
import { executePendingPowerRebuild, type PowerSampleRebuildState } from '../../lib/plan/rebuildScheduler/powerDriven';
import {
  invalidateRebuildSuppressionForObservation,
} from '../../lib/plan/rebuildScheduler/observationSuppression';

/** A tight rebuild that changed nothing — the outcome that arms the backoff. */
const TIGHT_NOOP = { actionChanged: false, appliedActions: false, failed: false };

const buildState = (): PowerSampleRebuildState => ({
  lastMs: 1_000,
  pendingReason: 'headroom_tight',
  tightNoopStreak: 0,
});

const runRebuild = async (params: {
  onFlight?: (setState: (s: PowerSampleRebuildState) => void, getState: () => PowerSampleRebuildState) => void;
  outcome?: typeof TIGHT_NOOP;
  reject?: boolean;
}): Promise<PowerSampleRebuildState> => {
  let state = buildState();
  const getState = (): PowerSampleRebuildState => state;
  const setState = (next: PowerSampleRebuildState): void => { state = next; };
  const run = executePendingPowerRebuild({
    getState,
    setState,
    getNowMs: () => 50_000,
    rebuildPlanFromCache: async () => {
      // Mid-flight: the observation lands after the rebuild read its devices.
      params.onFlight?.(setState, getState);
      if (params.reject) throw new Error('build exploded');
      return params.outcome ?? TIGHT_NOOP;
    },
  });
  await (params.reject ? run.catch(() => undefined) : run);
  return state;
};

describe('a device observation landing during an in-flight rebuild', () => {
  it('keeps its suppression clear instead of having it overwritten on completion', async () => {
    const state = await runRebuild({
      onFlight: (setState, getState) => {
        setState(invalidateRebuildSuppressionForObservation(getState()));
      },
    });

    // Without the in-flight guard, the tight-noop outcome re-armed the backoff
    // and cleared the latch — on a verdict about the pre-observation house.
    expect(state.backoffUntilMs).toBeUndefined();
    expect(state.tightNoopStreak).toBe(0);
    expect(state.shortfallSuppressionInvalidated).toBe(true);
  });

  // The narrow exception, and the one the P2 review caught: an observation must
  // not cost a rebuild that ACTED its settling window. That window is armed in
  // the same function the in-flight guard skips, and PELS's own command echo is
  // exactly the observation that lands mid-flight.
  it('still arms the post-mitigation holdoff when the overtaken rebuild acted', async () => {
    const state = await runRebuild({
      outcome: { actionChanged: true, appliedActions: true, failed: false },
      onFlight: (setState, getState) => {
        setState(invalidateRebuildSuppressionForObservation(getState()));
      },
    });

    expect(state.mitigationHoldoffUntilMs).toBeGreaterThan(50_000);
    // …without paying for it with the suppressions the observation cleared.
    expect(state.backoffUntilMs).toBeUndefined();
    expect(state.shortfallSuppressionInvalidated).toBe(true);
  });

  it('does the same when the in-flight rebuild fails', async () => {
    const state = await runRebuild({
      reject: true,
      onFlight: (setState, getState) => {
        setState(invalidateRebuildSuppressionForObservation(getState()));
      },
    });

    expect(state.backoffUntilMs).toBeUndefined();
    expect(state.shortfallSuppressionInvalidated).toBe(true);
  });

  // The guard must not disarm the throttle generally: with no observation, a
  // tight no-op still installs its backoff exactly as before.
  it('still arms the backoff when no observation landed', async () => {
    const state = await runRebuild({});

    expect(state.tightNoopStreak).toBe(1);
    expect(state.backoffUntilMs).toBeGreaterThan(50_000);
    // Never set on this path, so `clearShortfallSuppressionInvalidation` leaves
    // it absent rather than writing `false`.
    expect(state.shortfallSuppressionInvalidated).toBeFalsy();
  });

  it('still clears the latch when no observation landed', async () => {
    let state = buildState();
    state = invalidateRebuildSuppressionForObservation(state);
    const getState = (): PowerSampleRebuildState => state;
    const setState = (next: PowerSampleRebuildState): void => { state = next; };

    await executePendingPowerRebuild({
      getState,
      setState,
      getNowMs: () => 50_000,
      rebuildPlanFromCache: async () => TIGHT_NOOP,
      // Observation happened BEFORE dispatch, so the rebuild did see it: the
      // latch is a one-shot and must be spent here.
    });

    expect(state.shortfallSuppressionInvalidated).toBe(false);
  });
});
