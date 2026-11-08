import type { MainFuse } from '../../../packages/contracts/src/capacitySettings';
import type { PhaseFootprint, PhaseName } from '../../../packages/planner-types/src/phaseFootprint';
import type { PhaseLoad, PhaseReading } from '../../power/phaseReading';

/** One phase against the main fuse this cycle. */
export type PhaseMeasurement = {
  phase: PhaseName;
  /** The phase's load, kW. Signed (positive import) when the meter reports direction. */
  drawKw: number;
  targetKw: number;
  /** Room under the target, kW. Negative above it; an exporting phase has more than the target. */
  roomKw: number;
  breached: boolean;
};

export type PhasePower = { kind: 'off' } | { kind: 'on'; phases: readonly PhaseMeasurement[] };

export const PHASE_POWER_OFF: PhasePower = Object.freeze({ kind: 'off' });

const NOMINAL_PHASE_VOLTAGE_V = 230;
/** Target share of the fuse when the meter reports per-phase current. */
const TARGET_SHARE_WITH_CURRENT = 0.95;
/** Power alone understates current at a low power factor, so the target stays further from the fuse. */
const TARGET_SHARE_POWER_ONLY = 0.90;

const resolveDrawKw = (load: PhaseLoad, signed: boolean): number => {
  if (load.currentA === undefined) return load.kw;
  const magnitudeKw = load.currentA * NOMINAL_PHASE_VOLTAGE_V / 1000;
  return signed && load.kw < 0 ? -magnitudeKw : magnitudeKw;
};

/**
 * Each phase against the fuse: on only for a three-phase supply with neutral
 * and a trusted reading. Import direction only: an exporting phase is never
 * breached. A current-only meter cannot tell a phase's direction, so it acts
 * only while the home as a whole imports.
 */
export function resolvePhasePower(fuse: MainFuse, reading: PhaseReading, netKw: number): PhasePower {
  if (fuse.kind !== 'on' || fuse.supply !== 'three_phase_neutral') return PHASE_POWER_OFF;
  if (reading.kind !== 'healthy' || (!reading.signed && netKw <= 0)) return PHASE_POWER_OFF;
  const phases = reading.phases.map((load) => {
    const share = load.currentA === undefined ? TARGET_SHARE_POWER_ONLY : TARGET_SHARE_WITH_CURRENT;
    const targetKw = fuse.amps * NOMINAL_PHASE_VOLTAGE_V * share / 1000;
    const drawKw = resolveDrawKw(load, reading.signed);
    return { phase: load.phase, drawKw, targetKw, roomKw: targetKw - drawKw, breached: drawKw > targetKw };
  });
  return { kind: 'on', phases };
}

export const isPhaseBreached = (power: PhasePower): boolean => (
  power.kind === 'on' && power.phases.some((phase) => phase.breached)
);

/** How far the worst phase is over its target, kW; zero when none is. */
export const worstPhaseDeficitKw = (power: PhasePower): number => (
  power.kind === 'off' ? 0 : Math.max(0, ...power.phases.map((phase) => -phase.roomKw))
);

/** The phases with `kw` of room spoken for on this footprint; the draw and breach stay as measured. */
export function withholdPhaseRoom(power: PhasePower, footprint: PhaseFootprint, kw: number): PhasePower {
  if (power.kind === 'off' || footprint.kind === 'self_balancing') return power;
  const spent = (phase: PhaseName): number => {
    if (footprint.kind === 'single') return footprint.phase === phase ? kw : 0;
    return footprint.kind === 'all_three' ? kw / 3 : kw;
  };
  return { kind: 'on', phases: power.phases.map((phase) => ({ ...phase, roomKw: phase.roomKw - spent(phase.phase) })) };
}
