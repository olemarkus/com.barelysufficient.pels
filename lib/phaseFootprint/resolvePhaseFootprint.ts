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
  /** What PELS has settled from its own steps against the meter, when it has. */
  learned: PhaseFootprint | undefined;
};

/** Where a footprint came from, for the device page. */
export type PhaseFootprintSource = 'set' | 'reported' | 'learned' | 'none';

export type ResolvedPhaseFootprint = { footprint: PhaseFootprint; source: PhaseFootprintSource };

const fromOwnerConnection = (connection: DevicePhaseConnection): PhaseFootprint => {
  if (connection === 'all') return { kind: 'all_three' };
  if (connection === 'self_balancing') return { kind: 'self_balancing' };
  return { kind: 'single', phase: connection };
};

type LiveChargerRead = 'all_three' | 'fewer' | 'idle';

const readLiveCharger = (currentsA: readonly [number, number, number] | undefined): LiveChargerRead => {
  if (currentsA === undefined) return 'idle';
  const drawing = currentsA.filter((amps) => amps > CHARGER_PHASE_DRAWING_A).length;
  if (drawing === 0) return 'idle';
  return drawing === 3 ? 'all_three' : 'fewer';
};

const fromCharger = (facts: PhaseFootprintFacts): ResolvedPhaseFootprint => {
  const live = readLiveCharger(facts.chargerPhaseCurrentsA);
  if (live === 'all_three') return { footprint: { kind: 'all_three' }, source: 'reported' };
  const { learned } = facts;
  // A charger's "phase 1" need not be the meter's L1: fewer live phases name no
  // phase, but a learned single phase for this session does. Live outranks a
  // learned all-three, which fewer live phases contradict.
  if (live === 'fewer') {
    return learned?.kind === 'single'
      ? { footprint: learned, source: 'learned' }
      : { footprint: { kind: 'unknown' }, source: 'reported' };
  }
  if (learned !== undefined) return { footprint: learned, source: 'learned' };
  return facts.evPreset === 'ev_charger_3_phase'
    ? { footprint: { kind: 'all_three' }, source: 'reported' }
    : { footprint: { kind: 'unknown' }, source: facts.evPreset === undefined ? 'none' : 'reported' };
};

/**
 * Which phases this device loads, and how PELS knows: the owner's setting, then
 * what a charger measures, then what PELS has learned, then a charger's control
 * mode, otherwise unknown. The live reading sits above the control mode because
 * a three-phase charger can carry a one-phase car.
 */
export function resolvePhaseFootprintWithSource(facts: PhaseFootprintFacts): ResolvedPhaseFootprint {
  if (facts.ownerConnection !== undefined) {
    return { footprint: fromOwnerConnection(facts.ownerConnection), source: 'set' };
  }
  if (facts.isEvCharger) return fromCharger(facts);
  return facts.learned === undefined
    ? { footprint: { kind: 'unknown' }, source: 'none' }
    : { footprint: facts.learned, source: 'learned' };
}

export const resolvePhaseFootprint = (facts: PhaseFootprintFacts): PhaseFootprint => (
  resolvePhaseFootprintWithSource(facts).footprint
);
