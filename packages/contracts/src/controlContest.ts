/**
 * How a device's rounds against PELS went: `reverted`, it went back to its
 * value from before PELS's write (the write did not stick); `overridden`,
 * something set another value (a Flow, app or schedule with its own idea).
 */
export type ContestKind = 'reverted' | 'overridden';

/** The setting PELS kept setting back: a setpoint, the on/off switch, or a stepped load's level. */
export type ContestedSetting = 'temperature' | 'on_off' | 'level';

/**
 * A device whose setting keeps moving away from what PELS set and the device
 * kept, as the executor's `ControlContestRecord` answers it: from the round
 * that brings its rounds within 2 hours to the threshold until its latest
 * round is 2 hours old.
 */
export type ContestedControl = {
  setting: ContestedSetting;
  /** `reverted` when every round in the window was one, else `overridden`. */
  kind: ContestKind;
  /** Rounds within the last 2 hours: at least one, while the contest runs. */
  count: number;
  /**
   * When this contest began: the first of the rounds that reached the
   * threshold. It stays while the device stays contested, so a later contest
   * on the same device has a later one.
   */
  sinceMs: number;
};

/** Present on a listed device only while it is contested. */
export type ControlContestDecoration = { controlContest?: ContestedControl };
