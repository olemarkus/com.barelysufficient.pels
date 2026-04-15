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
};

export type PlanCapacityStateSummary = PlanCapacityStateCounts & {
  summarySource: CapacityStateSummarySource;
  summarySourceAtMs: number | null;
};

export type KnownPlanCapacityStateCounts = {
  [Key in keyof PlanCapacityStateCounts]: number;
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
  };
}
