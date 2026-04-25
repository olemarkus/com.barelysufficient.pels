export type CapacityStateSummarySource = 'plan_input' | 'plan_snapshot' | null;

export type PlanCapacityStateCounts = {
  controlledDevices: number | null;
  plannedShedDevices: number | null;
  pendingPlannedShedDevices: number | null;
  activePlannedShedDevices: number | null;
  activeControlledDevices: number | null;
  zeroDrawControlledDevices: number | null;
  staleControlledDevices: number | null;
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
  staleControlledDevices: number;
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

export function buildNullCapacityStateSummary(): PlanCapacityStateSummary {
  return {
    controlledDevices: null,
    plannedShedDevices: null,
    pendingPlannedShedDevices: null,
    activePlannedShedDevices: null,
    activeControlledDevices: null,
    zeroDrawControlledDevices: null,
    staleControlledDevices: null,
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
    staleControlledDevices: 0,
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
