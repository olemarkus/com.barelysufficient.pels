export type CapacityStateSummarySource = 'plan_input' | 'plan_snapshot' | null;

export type PlanCapacityStateCounts = {
  controlledDevices: number | null;
  plannedShedDevices: number | null;
  pendingPlannedShedDevices: number | null;
  activePlannedShedDevices: number | null;
  activeControlledDevices: number | null;
  zeroDrawControlledDevices: number | null;
  pendingControlledDevices: number | null;
  blockedByCooldownDevices: number | null;
  blockedByPenaltyDevices: number | null;
  blockedByInvariantDevices: number | null;
  controlledPowerW: number | null;
  uncontrolledPowerW: number | null;
  remainingReducibleControlledLoadW: number | null;
  remainingReducibleControlledLoad: boolean | null;
  remainingActionableControlledLoadW: number | null;
  remainingActionableControlledLoad: boolean | null;
  actuationInFlight: boolean | null;
};

export type PlanCapacityStateSummary = PlanCapacityStateCounts & {
  summarySource: CapacityStateSummarySource;
  summarySourceAtMs: number | null;
};

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

export function buildNullCapacityStateSummary(): PlanCapacityStateSummary {
  return {
    controlledDevices: null,
    plannedShedDevices: null,
    pendingPlannedShedDevices: null,
    activePlannedShedDevices: null,
    activeControlledDevices: null,
    zeroDrawControlledDevices: null,
    pendingControlledDevices: null,
    blockedByCooldownDevices: null,
    blockedByPenaltyDevices: null,
    blockedByInvariantDevices: null,
    controlledPowerW: null,
    uncontrolledPowerW: null,
    remainingReducibleControlledLoadW: null,
    remainingReducibleControlledLoad: null,
    remainingActionableControlledLoadW: null,
    remainingActionableControlledLoad: null,
    actuationInFlight: null,
    summarySource: null,
    summarySourceAtMs: null,
  };
}

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
