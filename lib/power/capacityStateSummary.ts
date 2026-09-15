/**
 * Where a capacity summary was read from: a plan build's input at a shortfall
 * verdict, the plan being assembled (the overshoot record), or the published
 * snapshot.
 */
export type CapacityStateSummarySource = 'plan_input' | 'plan_build' | 'plan_snapshot';

export type KnownPlanCapacityStateCounts = {
  controlledDevices: number;
  plannedShedDevices: number;
  pendingPlannedShedDevices: number;
  activePlannedShedDevices: number;
  activeControlledDevices: number;
  zeroDrawControlledDevices: number;
  pendingControlledDevices: number;
  blockedByCooldownDevices: number;
  blockedByPenaltyDevices: number;
  blockedByInvariantDevices: number;
  controlledPowerW: number;
  uncontrolledPowerW: number;
  remainingReducibleControlledLoadW: number;
  remainingReducibleControlledLoad: boolean;
  remainingActionableControlledLoadW: number;
  remainingActionableControlledLoad: boolean;
  actuationInFlight: boolean;
};

/**
 * A published plan's capacity state. Every count and every load figure is
 * known whenever there is a plan; "no plan yet" is the whole summary being
 * absent (`buildPublishedPlanCapacityStateSummary` answers `null`), not
 * nineteen fields each free to be null on their own. One pair stays nullable,
 * for the one reachable state that needs it: the managed/background split on an
 * unmeasured build.
 */
export type PlanCapacityStateSummary = Omit<KnownPlanCapacityStateCounts, 'controlledPowerW' | 'uncontrolledPowerW'> & {
  controlledPowerW: number | null;
  uncontrolledPowerW: number | null;
  summarySource: CapacityStateSummarySource;
  summarySourceAtMs: number;
};

/**
 * The plan input's capacity state at a hard-cap verdict: what one build walked
 * from its device list over the shortfall threshold, and nothing it did not. The
 * restore-side hold counts (`blockedBy*`) are absent because a plan input carries
 * no reasons to count them from; `remainingActionable*` is the load the build's
 * own shed candidates could still relieve, and `shedReliefInFlight` whether a
 * shed this build or an earlier one decided has yet to land — together, the
 * verdict itself (`CapacityGuard.recordPlanVerdict`). No field can be the null stand-in a
 * caller without the device list would otherwise reach for.
 */
export type PlanInputCapacityStateSummary = Omit<
  KnownPlanCapacityStateCounts,
  'blockedByCooldownDevices' | 'blockedByPenaltyDevices' | 'blockedByInvariantDevices'
> & {
  shedReliefInFlight: boolean;
  summarySource: 'plan_input';
  summarySourceAtMs: number;
};

export function buildEmptyCapacityStateSummary(): KnownPlanCapacityStateCounts {
  return {
    controlledDevices: 0,
    plannedShedDevices: 0,
    pendingPlannedShedDevices: 0,
    activePlannedShedDevices: 0,
    activeControlledDevices: 0,
    zeroDrawControlledDevices: 0,
    pendingControlledDevices: 0,
    blockedByCooldownDevices: 0,
    blockedByPenaltyDevices: 0,
    blockedByInvariantDevices: 0,
    controlledPowerW: 0,
    uncontrolledPowerW: 0,
    remainingReducibleControlledLoadW: 0,
    remainingReducibleControlledLoad: false,
    remainingActionableControlledLoadW: 0,
    remainingActionableControlledLoad: false,
    actuationInFlight: false,
  };
}
