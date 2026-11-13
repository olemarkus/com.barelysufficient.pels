/** The setting PELS kept setting back: a setpoint, the on/off switch, or a stepped load's level. */
export type ContestedSetting = 'temperature' | 'on_off' | 'level' | 'charging_phases';

/** A setpoint, an on/off state or a step id. */
export type ContestedValue = number | boolean | string;

/**
 * A device whose setting keeps reading another value after PELS set it, as the
 * executor's `ControlContestRecord` answers it: from the round that brings its
 * rounds within the last hour to the threshold until its latest round is an
 * hour old. It says what PELS measured, not who moved the setting: Homey does
 * not say.
 */
export type ContestedControl = {
  setting: ContestedSetting;
  /** What PELS set in the latest round. */
  commanded: ContestedValue;
  /** What the device reported instead in the latest round. */
  observed: ContestedValue;
  /** Rounds within the last hour: at least one, while the contest runs. */
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
