/**
 * How a device's rounds against PELS went: `reverted`, it went back to its
 * value from before PELS's write (the write did not stick); `overridden`,
 * something set another value (a Flow, app or schedule with its own idea).
 */
export type ContestKind = 'reverted' | 'overridden';

/**
 * A device whose control setting keeps moving away from what PELS set, as the
 * device layer's `ControlContestObserver` answers it while the rounds within
 * the last hour reach its threshold.
 */
export type ContestedControl = {
  /** The setting changed most recently. */
  capabilityId: string;
  /** `reverted` when every round in the window was one, else `overridden`. */
  kind: ContestKind;
  /** Rounds within the last hour. */
  count: number;
  /** The first of those rounds. */
  sinceMs: number;
};

/** Present on a listed device only while it is contested. */
export type ControlContestDecoration = { controlContest?: ContestedControl };
