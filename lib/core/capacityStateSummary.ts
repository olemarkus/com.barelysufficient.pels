export type PlanCapacityStateSummary = {
  controlledDevices: number | null;
  shedDevices: number | null;
  activeControlledDevices: number | null;
  zeroDrawControlledDevices: number | null;
  staleControlledDevices: number | null;
  pendingControlledDevices: number | null;
  blockedByCooldownDevices: number | null;
  blockedByPenaltyDevices: number | null;
  blockedByInvariantDevices: number | null;
};

export type KnownPlanCapacityStateSummary = {
  [Key in keyof PlanCapacityStateSummary]: number;
};

export function buildNullCapacityStateSummary(): PlanCapacityStateSummary {
  return {
    controlledDevices: null,
    shedDevices: null,
    activeControlledDevices: null,
    zeroDrawControlledDevices: null,
    staleControlledDevices: null,
    pendingControlledDevices: null,
    blockedByCooldownDevices: null,
    blockedByPenaltyDevices: null,
    blockedByInvariantDevices: null,
  };
}

export function buildEmptyCapacityStateSummary(): KnownPlanCapacityStateSummary {
  return {
    controlledDevices: 0,
    shedDevices: 0,
    activeControlledDevices: 0,
    zeroDrawControlledDevices: 0,
    staleControlledDevices: 0,
    pendingControlledDevices: 0,
    blockedByCooldownDevices: 0,
    blockedByPenaltyDevices: 0,
    blockedByInvariantDevices: 0,
  };
}
