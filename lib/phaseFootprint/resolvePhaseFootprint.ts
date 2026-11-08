import type { TargetPowerSteppedLoadPreset } from '../../packages/contracts/src/types';
import type { PhaseFootprint } from '../../packages/planner-types/src/phaseFootprint';
import type { DevicePhaseConnection } from '../../packages/shared-domain/src/settings/devicePhaseConnections';

/** A charger phase drawing at or below this is not carrying the car. */
const CHARGER_PHASE_DRAWING_A = 1;

/** What the footprint is resolved from. The producer reads each fact from its owner. */
export type PhaseFootprintFacts = {
  ownerConnection: DevicePhaseConnection | undefined;
  isEvCharger: boolean;
  /** The charger's own per-phase current, A, when it reports all three. */
  chargerPhaseCurrentsA: readonly [number, number, number] | undefined;
  /** The EV control mode, when the device has one. */
  evPreset: TargetPowerSteppedLoadPreset | undefined;
};

const fromOwnerConnection = (connection: DevicePhaseConnection): PhaseFootprint => {
  if (connection === 'all') return { kind: 'all_three' };
  if (connection === 'self_balancing') return { kind: 'self_balancing' };
  return { kind: 'single', phase: connection };
};

const fromLiveCharger = (currentsA: readonly [number, number, number] | undefined): PhaseFootprint | undefined => {
  if (currentsA === undefined) return undefined;
  const drawing = currentsA.filter((amps) => amps > CHARGER_PHASE_DRAWING_A).length;
  if (drawing === 0) return undefined;
  // A charger's "phase 1" need not be the meter's L1, so one or two drawing
  // phases say how many conductors carry the car, not which ones.
  return drawing === 3 ? { kind: 'all_three' } : { kind: 'unknown' };
};

const fromEvPreset = (preset: TargetPowerSteppedLoadPreset | undefined): PhaseFootprint => (
  preset === 'ev_charger_3_phase' ? { kind: 'all_three' } : { kind: 'unknown' }
);

/**
 * Which phases this device loads: the owner's setting, then what a charger
 * measures, then its control mode, and otherwise unknown. The live reading sits
 * above the control mode because a three-phase charger can carry a one-phase car.
 */
export function resolvePhaseFootprint(facts: PhaseFootprintFacts): PhaseFootprint {
  if (facts.ownerConnection !== undefined) return fromOwnerConnection(facts.ownerConnection);
  if (!facts.isEvCharger) return { kind: 'unknown' };
  return fromLiveCharger(facts.chargerPhaseCurrentsA) ?? fromEvPreset(facts.evPreset);
}
