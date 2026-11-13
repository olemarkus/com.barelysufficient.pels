import type {
  ChargingPhaseCount, ChargingPhaseMode, ChargingPhaseVector,
} from '../../contracts/src/chargingPhases.js';
import type { SteppedLoadProfile } from '../../contracts/src/types.js';
import type { PhaseFootprint } from './phaseFootprint.js';

/** A permitted future operating envelope, never a replacement for the observed ladder. */
export type ChargingPhaseEnvelope = {
  phases: ChargingPhaseCount;
  profile: SteppedLoadProfile;
  footprint: PhaseFootprint;
};

/** A physical operating point; power vectors are in house-meter phase order, in kW. */
export type ChargingPhasePoint = {
  phases: ChargingPhaseCount;
  currentA: number;
  totalKw: number;
  perPhaseKw: ChargingPhaseVector;
};

/** An admission debit: only incoming load, with no unobserved outgoing relief. */
export type ChargingPhaseDebit = {
  totalKw: number;
  perPhaseKw: ChargingPhaseVector;
};

/** Producer-resolved candidates whose control owner permits a phase operation now. */
export type ChargingPhaseCandidate = {
  deviceId: string;
  mode: ChargingPhaseMode;
  forceSinglePhase: boolean;
  observed: ChargingPhasePoint;
  envelopes: readonly ChargingPhaseEnvelope[];
  minimumCurrentA: number;
};

/** Absolute worst-case load retained while firmware changes its operating mode. */
export type ChargingPhaseReservation = {
  deviceId: string;
  totalKw: number;
  perPhaseKw: ChargingPhaseVector;
};
