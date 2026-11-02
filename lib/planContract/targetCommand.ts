/** The planner's selected temperature write and its historical restore classification. */
export type PlannedTargetCommand = {
  deviceId: string;
  name: string;
  desired: number;
  purpose: 'target_update' | 'shed_temperature';
  /** Planner-resolved (`finalizePlanDevices`): applying this write counts as
   * a restore, so the executor stamps the restore clocks when it lands. The
   * executor never re-derives this from shed config — why the planner chose
   * the setpoint is the planner's problem (owner ruling, 2026-08-25).
   *
   * Classified against the observation the PLAN was decided from, not a
   * re-read at apply time (the old executor inference compared the live
   * snapshot against raw shed config). If the observation moves between
   * build and apply, this stamp describes the build's world: an observed
   * value that converged onto the desired one no-ops before the flag is ever
   * read, and any other move is one rebuild away from a fresh classification
   * — in production every executor tick IS a rebuild. The projection honors
   * the flag only when the write still moves the setpoint the way the plan's
   * did (a pure diff-domain guard, see {@link restoreFromTarget}): a frozen
   * restore verdict applied to an observation that moved past the desired
   * value would advance the restore clocks for a write going the OTHER way and
   * delay legitimate restores by the backoff. */
  recordRestoreOnTargetApply: boolean;
  /**
   * The observed setpoint the plan decided this write from. The restore guard
   * compares its side of `desired` with the side the live observation is on,
   * which needs no direction: a heater resumes UP and a cooling unit resumes
   * DOWN, and the planner already decided which one this is. A `>` here was a
   * heating assumption that never recorded a cooling unit's resume.
   */
  restoreFromTarget: number;
};
