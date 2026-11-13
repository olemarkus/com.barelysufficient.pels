import type { ChargingPhasePoint, ChargingPhaseReservation } from '../../packages/planner-types/src/chargingPhases';

/** One phase operation admitted at the device's existing priority turn. */
export type ChargingPhaseDecision =
  | { kind: 'prepare'; deviceId: string; target: ChargingPhasePoint; reservation: ChargingPhaseReservation }
  | { kind: 'switch'; deviceId: string; target: ChargingPhasePoint; reservation: ChargingPhaseReservation }
  | { kind: 'release'; deviceId: string };
