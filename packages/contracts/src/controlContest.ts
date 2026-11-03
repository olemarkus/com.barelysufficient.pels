/** The setting PELS kept setting back: a setpoint, the on/off switch, or a stepped load's level. */
export type ContestedSetting = 'temperature' | 'on_off' | 'level';

/** A setpoint, an on/off state or a step id. */
export type ContestedValue = number | boolean | string;

/**
 * A device whose setting keeps reading another value after PELS set it, as the
 * executor's `ControlContestRecord` answers it while the rounds within the last
 * hour reach its threshold. It says what PELS measured, not who moved the
 * setting: Homey does not say.
 */
export type ContestedControl = {
  setting: ContestedSetting;
  /** What PELS set in the latest round. */
  commanded: ContestedValue;
  /** What the device reported instead in the latest round. */
  observed: ContestedValue;
  /** Rounds within the last hour. */
  count: number;
  /** The first of those rounds. */
  sinceMs: number;
};

/** Present on a listed device only while it is contested. */
export type ControlContestDecoration = { controlContest?: ContestedControl };
