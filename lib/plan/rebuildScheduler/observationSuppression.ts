import type { PowerSampleRebuildState } from './powerDriven';

/**
 * What a device observation is allowed to do to the rebuild schedule.
 *
 * An observation is not a rebuild trigger (`lib/plan/planRebuildTrigger.ts`) —
 * it changes WHETHER the next whole-home reading decides, never WHAT it decides
 * from. That distinction matters because two throttles exist to skip rebuilds
 * that provably cannot change anything, and both derive that verdict from the
 * device set as it was:
 *
 * - `shortfallSuppressionInvalidated` gates the unactionable throttle, which
 *   holds a house in shortfall to the max-interval cadence once a plan proves
 *   nothing more can be shed;
 * - the tight-noop backoff (`tightNoopStreak` / `backoffUntilMs`, up to 120 s)
 *   does the same after a tight rebuild that changed nothing.
 *
 * A device that just turned on adds a controllable load; one that turned off
 * freed the headroom a restore needs. Either way "nothing is actionable" is a
 * verdict about a house that no longer exists, and without this the next reading
 * could be throttled away on the strength of it.
 *
 * Two neighbouring suppressions are deliberately NOT cleared, and between them
 * they bound what this buys:
 *
 * - `mitigationHoldoffUntilMs` holds off after a tight rebuild that DID act, so
 *   the action can take effect before PELS decides again — and an observation is
 *   frequently that action landing. Clearing it would make PELS re-decide on its
 *   own command. `isTightNoopBackoffActive` reads either field, so for that
 *   holdoff's 15 s this clear buys nothing on the tight path. For the same
 *   reason an observation that overtakes an acting rebuild still lets that
 *   rebuild arm its holdoff (`settleAfterOvertakenRebuild`).
 * - `tightUnactionable` floors EXECUTED rebuilds at 15 s
 *   (`PlanRebuildIntentPolicy.resolveDueAtMs`), and `policy.ts` says outright it
 *   "stays independent of the latch so the floor still bites when the latch
 *   bypasses the decision throttle". It is a CPU-watchdog bound on rebuild
 *   frequency, not a claim about what is actionable — the same bound any load
 *   switching on already lives under.
 *
 * So an observation buys a re-check at the decision gates, which those two may
 * still space by up to 15 s. The removed observation lane bypassed the scheduler
 * entirely and was the only thing that ever escaped them.
 */
export const invalidateRebuildSuppressionForObservation = (
  state: PowerSampleRebuildState,
): PowerSampleRebuildState => ({
  ...state,
  shortfallSuppressionInvalidated: true,
  tightNoopStreak: 0,
  backoffUntilMs: undefined,
  // Bumping this is what makes the clear survive a rebuild that is ALREADY in
  // flight. That rebuild read its devices before this observation existed, so
  // its verdict is about the old house — and without the counter its completion
  // handler would re-install the backoff and clear the latch it never saw.
  observationSeq: (state.observationSeq ?? 0) + 1,
});
