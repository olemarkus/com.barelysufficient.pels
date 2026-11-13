import type {
  ChargingPhaseCandidate, ChargingPhaseEnvelope, ChargingPhasePoint, ChargingPhaseReservation,
} from '../../packages/planner-types/src/chargingPhases';
import type { ChargingPhaseDecision, ChargingPhasePlanningRead } from '../ports/chargingPhases';

/** Mutable construction of one complete owner read; consumers receive the readonly port. */
export class ChargingPhasePlanningSnapshot implements ChargingPhasePlanningRead {
  readonly candidates: ChargingPhaseCandidate[] = [];
  readonly reservations: ChargingPhaseReservation[] = [];
  readonly releases: ChargingPhaseDecision[] = [];
  readonly observations: (ChargingPhasePoint & { deviceId: string })[] = [];
  readonly permittedEnvelopes = new Map<string, readonly ChargingPhaseEnvelope[]>();
  readonly continuations: Extract<ChargingPhaseDecision, { kind: 'switch' }>[] = [];
}
