import { describe, expect, it } from 'vitest';
import { buildEmptyCapacityStateSummary, buildNullCapacityStateSummary } from '../../lib/power/capacityStateSummary';
import { OvershootIncident } from '../../lib/plan/overshootIncident';
import { resolvePlanRebuildPosture } from '../../lib/plan/planRebuildPosture';

/** A state whose overshoot incident is open. */
const activeIncident = (): OvershootIncident => {
  const incident = new OvershootIncident();
  incident.enter(Date.now());
  return incident;
};

// The one producer of what the throttle gates on. The shortfall half is pinned
// on the single field it reads: the summary's blocker counters and in-flight
// flag say why load is not actionable, not whether any is.
const summaryWith = (overrides: Partial<ReturnType<typeof buildEmptyCapacityStateSummary>>) => ({
  ...buildEmptyCapacityStateSummary(),
  summarySource: null,
  summarySourceAtMs: null,
  ...overrides,
});

describe('resolvePlanRebuildPosture', () => {
  it('reads shortfall unrecoverability off remainingActionableControlledLoad alone', () => {
    for (const extra of [
      { blockedByCooldownDevices: 1 },
      { blockedByPenaltyDevices: 1 },
      { actuationInFlight: true },
      {},
    ]) {
      const posture = resolvePlanRebuildPosture(
        summaryWith({ remainingActionableControlledLoad: false, ...extra }),
        null,
      );
      expect(posture.shortfallUnrecoverable).toBe(true);
    }
  });

  it('is not unrecoverable when the summary could not say, or load remains', () => {
    expect(resolvePlanRebuildPosture(buildNullCapacityStateSummary(), null).shortfallUnrecoverable).toBe(false);
    expect(resolvePlanRebuildPosture(summaryWith({ remainingActionableControlledLoad: true }), null)
      .shortfallUnrecoverable).toBe(false);
  });

  it('never counts an unactionable overshoot as converging', () => {
    // An unwinnable overshoot with nothing in flight: convergence would bypass
    // the throttle's anti-storm gates on a plan that cannot change anything.
    const posture = resolvePlanRebuildPosture(
      summaryWith({ remainingActionableControlledLoad: false, remainingReducibleControlledLoad: false }),
      { pendingSheds: new Set(), pendingRestores: new Set(), pendingTargetCommands: {}, pendingBinaryCommands: {}, overshoot: activeIncident() },
    );
    expect(posture.unactionable).toBe(true);
    expect(posture.planConvergenceActive).toBe(false);
  });
});
