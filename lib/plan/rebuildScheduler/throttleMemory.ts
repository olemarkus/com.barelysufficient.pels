import type { HardCapBreach } from './rebuildSignal';

/** The rebuild that last ran: when, and what the policy thresholds the next sample against. */
export type LastRebuild = {
  atMs: number;
  powerW: number;
  /**
   * Stamped when the rebuild COMPLETES, from the signal it ran for. While it
   * runs, the previous rebuild's breach stands here, so a sample arriving
   * mid-flight is judged against the last verdict that finished.
   */
  hardCapBreach: HardCapBreach;
};

/**
 * The one clock that spaces tight rebuilds. `noop`: rebuilds keep proving
 * nothing is actionable, so they widen (15 → 30 → 60 → 120 s with the streak).
 * `mitigation`: a tight rebuild DID act, so PELS waits for the action to land
 * before deciding again. An observation clears a `noop` holdoff — its verdict is
 * about a house that no longer exists — but never a `mitigation` one, because
 * the observation is frequently that action landing.
 */
export type RebuildHoldoff = { untilMs: number; cause: 'noop' | 'mitigation' };

/**
 * What the throttle remembers between samples. Five facts, each with one owner
 * below: the last rebuild (the delta and hard-cap gates), the tight-noop streak
 * and its holdoff (the backoff gate), the invalidation latch and observation
 * counter (what un-suppresses), and the last decision's execution floor. The
 * queued request and the in-flight rebuild are NOT memory — they are the
 * throttle's live work, and `snapshot()` reports them beside it.
 */
export type PlanRebuildThrottleMemory = {
  lastRebuild: LastRebuild | null;
  noopStreak: number;
  holdoff: RebuildHoldoff | null;
  /**
   * Set by a device observation, cleared by the next completed rebuild or by
   * leaving shortfall: the "nothing is actionable" verdict the shortfall
   * throttle rests on has been falsified, so the next reading gets one re-check.
   */
  suppressionInvalidated: boolean;
  /**
   * Bumped by every device observation. A rebuild captures it at dispatch and
   * compares on completion: if it moved, the house changed after the rebuild read
   * its devices, so that rebuild's verdict may not install a backoff.
   */
  observationSeq: number;
  /** The last decision proved nothing actionable while a boundary was active — floors executed rebuilds at 15 s. */
  lastDecisionUnactionable: boolean;
};

export const initialPlanRebuildThrottleMemory = (): PlanRebuildThrottleMemory => ({
  lastRebuild: null,
  noopStreak: 0,
  holdoff: null,
  suppressionInvalidated: false,
  observationSeq: 0,
  lastDecisionUnactionable: false,
});
