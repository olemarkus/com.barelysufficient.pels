/** A stepped command issued through the actuator, including its acknowledgement policy. */
export type MarkSteppedLoadDesiredStepIssuedParams = {
  deviceId: string;
  desiredStepId: string;
  previousStepId?: string;
  issuedAtMs?: number;
  confirmationPolicy?: 'required' | 'assume_applied';
  planningPowerW?: number;
  previousPlanningPowerW?: number;
  targetPowerProbeConfirmedMaxPowerW?: number;
  /**
   * The command left our socket but nothing acknowledged it. The pending record
   * is still written — that is the point, it is what keeps the device unsettled
   * — but nothing downstream may turn the write into a conclusion ABOUT the
   * device. Specifically it must not arm the target-power reachability probe: a
   * probe that settles unobserved counts a failure and backs off for 15-60
   * minutes, which would let an abandoned socket answer "this charger cannot
   * reach that rung" on evidence that never existed.
   */
  unacknowledged?: boolean;
};
