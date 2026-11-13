import type { PhaseFootprint, PhaseName } from '../../../packages/planner-types/src/phaseFootprint';
import { SHEDDING_CLEAR_THRESHOLD_KW } from '../planConstants';
import type { LimitHeadroom } from '../planContext';
import type { PhasePower } from './phasePower';
import type { ChargingPhaseVector } from '../../../packages/contracts/src/chargingPhases';

/** Spendable room per phase at the start of a restore pass; `off` when phases are not protected. */
export type PhaseRoomAxis =
  | { kind: 'off' }
  | { kind: 'on'; roomKw: Readonly<Record<PhaseName, number>> };

export const PHASE_ROOM_OFF: PhaseRoomAxis = Object.freeze({ kind: 'off' });

const PHASE_NAMES: readonly PhaseName[] = ['L1', 'L2', 'L3'];

/** The share of a device's relief that lands on this phase; unknown is credited nothing. */
export const phaseShare = (footprint: PhaseFootprint, phase: PhaseName): number => {
  if (footprint.kind === 'all_three') return 1 / 3;
  return footprint.kind === 'single' && footprint.phase === phase ? 1 : 0;
};

/** The grid clear band, bounded to a tenth of the phase target for small fuses. */
const resolvePhaseClearBandKw = (targetKw: number): number => Math.min(SHEDDING_CLEAR_THRESHOLD_KW, targetKw * 0.1);

/** Room to resume into: each phase's room less its clear band, so a restore cannot land on the target. */
export function resolvePhaseRoomAxis(power: PhasePower): PhaseRoomAxis {
  if (power.kind === 'off') return PHASE_ROOM_OFF;
  const roomKw = Object.fromEntries(
    power.phases.map((phase) => [phase.phase, phase.roomKw - resolvePhaseClearBandKw(phase.targetKw)]),
  ) as Record<PhaseName, number>;
  return { kind: 'on', roomKw };
}

const lowestRoomKw = (axis: Extract<PhaseRoomAxis, { kind: 'on' }>): number => (
  Math.min(...PHASE_NAMES.map((phase) => axis.roomKw[phase]))
);

/**
 * What this device may add within the phases, kW. A three-phase load puts a
 * third on each phase, so its room is the lowest phase's times three; a load on
 * an unknown phase has only the lowest phase's room.
 */
export function phaseRoomFor(axis: PhaseRoomAxis, footprint: PhaseFootprint): LimitHeadroom {
  if (axis.kind === 'off' || footprint.kind === 'self_balancing') return { kind: 'off' };
  if (footprint.kind === 'single') return { kind: 'on', kw: axis.roomKw[footprint.phase] };
  const lowestKw = lowestRoomKw(axis);
  return { kind: 'on', kw: footprint.kind === 'all_three' ? lowestKw * 3 : lowestKw };
}

/** The axis after a device on this footprint spends `spentKw`. */
export function spendPhaseRoom(axis: PhaseRoomAxis, footprint: PhaseFootprint, spentKw: number): PhaseRoomAxis {
  if (axis.kind === 'off' || footprint.kind === 'self_balancing') return axis;
  const spend = (phase: PhaseName): number => {
    if (footprint.kind === 'single') return footprint.phase === phase ? spentKw : 0;
    return footprint.kind === 'all_three' ? spentKw / 3 : spentKw;
  };
  const roomKw = Object.fromEntries(
    PHASE_NAMES.map((phase) => [phase, axis.roomKw[phase] - spend(phase)]),
  ) as Record<PhaseName, number>;
  return { kind: 'on', roomKw };
}

/**
 * How much of a swap donor's relief reaches the target, as a fraction. Without
 * phase pressure on this target every watt counts. When its phases cannot fund
 * it, only what the donor frees on the target's phases does: a donor with no
 * share of them is worth nothing.
 */
export function swapDonorPhaseShare(
  axis: PhaseRoomAxis,
  target: PhaseFootprint,
  donor: PhaseFootprint,
  neededKw: number,
): number {
  const room = phaseRoomFor(axis, target);
  if (room.kind === 'off' || room.kw >= neededKw) return 1;
  if (target.kind === 'single') return phaseShare(donor, target.phase);
  if (donor.kind !== 'all_three') return 0;
  // A three-phase target reads the lowest phase times three, which a third on each raises one for one.
  return target.kind === 'all_three' ? 1 : 1 / 3;
}

/** The surplus pool as this device may use it: within its phase room, plus what it already draws there. */
export function phaseBoundedPoolKw(
  axis: PhaseRoomAxis,
  footprint: PhaseFootprint,
  poolKw: number,
  ownDrawKw: number,
): number {
  const room = phaseRoomFor(axis, footprint);
  return room.kind === 'off' ? poolKw : Math.min(poolKw, room.kw + ownDrawKw);
}

/** The phase that limits this footprint: its own, or the one with least room. */
export function bindingPhaseFor(axis: Extract<PhaseRoomAxis, { kind: 'on' }>, footprint: PhaseFootprint): PhaseName {
  if (footprint.kind === 'single') return footprint.phase;
  return [...PHASE_NAMES].sort((a, b) => axis.roomKw[a] - axis.roomKw[b])[0] ?? 'L1';
}

/** Export past each phase's target still to be soaked up this cycle, kW. */
export type PhaseExportRemainder = ReadonlyMap<PhaseName, number>;

export const resolvePhaseExportRemainder = (power: PhasePower): PhaseExportRemainder => (
  new Map(power.kind === 'off' ? [] : power.phases.flatMap((phase) => (
    phase.exportExcessKw > 0 ? [[phase.phase, phase.exportExcessKw] as const] : []
  )))
);

/**
 * What this device could soak up of the export left on its phases, kW. A
 * three-phase device also loads the phases that are not exporting, so what it
 * can take is held to their import room.
 */
export function phaseExportPoolKw(
  remainder: PhaseExportRemainder,
  footprint: PhaseFootprint,
  room: PhaseRoomAxis,
): number {
  if (remainder.size === 0) return 0;
  if (footprint.kind === 'single') return remainder.get(footprint.phase) ?? 0;
  if (footprint.kind !== 'all_three') return 0;
  const exportKw = Math.max(0, ...remainder.values()) * 3;
  if (room.kind === 'off') return exportKw;
  const otherRoomKw = PHASE_NAMES.filter((phase) => !remainder.has(phase)).map((phase) => room.roomKw[phase] * 3);
  return Math.max(0, Math.min(exportKw, ...otherRoomKw));
}

/** The remainder after a device on this footprint claims `kw` of it. */
export function spendPhaseExport(
  remainder: PhaseExportRemainder,
  footprint: PhaseFootprint,
  kw: number,
): PhaseExportRemainder {
  if (kw <= 0 || remainder.size === 0) return remainder;
  return new Map([...remainder].map(([phase, leftKw]) => (
    [phase, Math.max(0, leftKw - kw * phaseShare(footprint, phase))] as const
  )).filter(([, leftKw]) => leftKw > 0));
}

/** What surplus claimants may still use of the phases this cycle. */
export type PhaseBudget = { room: PhaseRoomAxis; exportRemainder: PhaseExportRemainder };

export const resolvePhaseBudget = (power: PhasePower): PhaseBudget => ({
  room: resolvePhaseRoomAxis(power),
  exportRemainder: resolvePhaseExportRemainder(power),
});

export const spendPhaseBudget = (budget: PhaseBudget, footprint: PhaseFootprint, kw: number): PhaseBudget => ({
  room: spendPhaseRoom(budget.room, footprint, kw),
  exportRemainder: spendPhaseExport(budget.exportRemainder, footprint, kw),
});

/** Incoming phase load only: moving a load never credits its old phase before measurement. */
export function spendPhaseVector(axis: PhaseRoomAxis, incomingKw: ChargingPhaseVector): PhaseRoomAxis {
  if (axis.kind === 'off') return axis;
  return { kind: 'on', roomKw: {
    L1: axis.roomKw.L1 - incomingKw.L1,
    L2: axis.roomKw.L2 - incomingKw.L2,
    L3: axis.roomKw.L3 - incomingKw.L3,
  } };
}

/** A physical operating point spends the same incoming vector on import and export admission. */
export const spendPhaseBudgetVector = (budget: PhaseBudget, incomingKw: ChargingPhaseVector): PhaseBudget => ({
  room: spendPhaseVector(budget.room, incomingKw),
  exportRemainder: new Map([...budget.exportRemainder].map(([phase, kw]) => (
    [phase, Math.max(0, kw - incomingKw[phase])] as const
  )).filter(([, kw]) => kw > 0)),
});
