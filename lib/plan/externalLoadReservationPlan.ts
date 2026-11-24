import type {
  ExternalLoadReadyEvidence, ExternalLoadReservationDecision, ExternalLoadReservationSnapshot,
} from '../power/externalLoadReservations';
import type { MeasuredPowerReading } from '../power/powerCycleReading';
import type { MainFuse } from '../../packages/contracts/src/capacitySettings';
import type { RestorePlanResult } from './restore';
import type { RestoreHeadroomAxes } from './restore/headroomLedger';
import type { HoldPlanResult } from './planBuilderMaterialization';
import {
  minLimitHeadroom, resolveMeasuredPower, spendLimitHeadroom,
  type CapacityPlanLimit, type MeasuredPower, type PlanContext,
} from './planContext';
import type { PhasePower } from './phase/phasePower';
import type { DevicePlan, PlanInputDevice } from './planTypes';
import type { ChargingInstallationPlan } from './chargingInstallationPlan';

function reservePhaseRoom(phasePower: PhasePower, kw: number): PhasePower {
  if (phasePower.kind === 'off') return phasePower;
  return {
    kind: 'on',
    phases: phasePower.phases.map((phase) => {
      const roomKw = phase.roomKw - kw;
      return { ...phase, roomKw, breached: roomKw < 0 };
    }),
  };
}

/** Resolve measured and reservation-adjusted power against one set of limits. */
export function resolveExternalLoadPlanningPower(
  reading: MeasuredPowerReading,
  context: PlanContext,
  capacity: CapacityPlanLimit,
  usageDevices: PlanInputDevice[],
  mainFuse: MainFuse,
  reservation: ExternalLoadReservationSnapshot,
) {
  const measuredPower = resolveMeasuredPower(reading, context, usageDevices, mainFuse);
  const power = reserveExternalLoadPower(measuredPower, capacity, reading, reservation);
  return { measuredPower, power, mainFuse, reservation };
}

function reserveExternalLoadPower(
  power: MeasuredPower,
  ordinaryCapacity: CapacityPlanLimit,
  reading: MeasuredPowerReading,
  snapshot: ExternalLoadReservationSnapshot,
): MeasuredPower {
  const { committedKw } = snapshot;
  if (committedKw === 0 || (power.capacityHeadroom.kind === 'off' && power.gridHeadroom.kind === 'off')) return power;
  const capacityHeadroom = spendLimitHeadroom(minLimitHeadroom(
    power.capacityHeadroom,
    ordinaryCapacity.kind === 'off'
      ? { kind: 'off' } : { kind: 'on', kw: reading.headroomKw(ordinaryCapacity.paceKw) },
  ), committedKw);
  return {
    ...power,
    headroom: minLimitHeadroom(spendLimitHeadroom(power.headroom, committedKw), capacityHeadroom),
    capacityHeadroom,
    gridHeadroom: spendLimitHeadroom(power.gridHeadroom, committedKw),
    budgetHeadroom: spendLimitHeadroom(power.budgetHeadroom, committedKw),
    phase: reservePhaseRoom(power.phase, committedKw),
  };
}

export function resolveExternalLoadReservationDecision(
  snapshot: ExternalLoadReservationSnapshot,
  context: PlanContext,
  reading: MeasuredPowerReading,
  mainFuse: MainFuse,
  restore: RestorePlanResult,
  hold: HoldPlanResult,
  dryRun: boolean,
): ExternalLoadReservationDecision | undefined {
  const { revision } = snapshot;
  if (revision === 0) return undefined;
  const waiting = { kind: 'waiting', reservationRevision: revision } as const;
  if (dryRun || snapshot.committedKw === 0 || !hasExternalCapacity(context, hold.ledgerAxes)) return waiting;
  if (restore.timing.inRestoreCooldown || hold.restoredOneThisCycle
    || restore.restoredThisCycle.size > 0 || restore.storageHandedBack.size > 0) return waiting;
  if (hold.planDevices.some((device) => device.binaryCommandPending || device.stepCommandPending)) return waiting;
  const phaseEvidence = resolvePhaseEvidence(reading, mainFuse, hold.ledgerAxes);
  if (phaseEvidence === null) return waiting;
  return { kind: 'ready', reservationRevision: revision, sampledAtMs: reading.lastPowerUpdateMs, phaseEvidence };
}

/** Installation switches are materialized after the ordinary restore passes. */
export function withExternalLoadReservationDecision(
  plan: DevicePlan,
  installations: ChargingInstallationPlan,
  decision: ExternalLoadReservationDecision | undefined,
): DevicePlan {
  if (decision === undefined) return plan;
  const externalLoadReservation = decision.kind === 'ready' && installations.hasUnobservedStart(plan)
    ? { kind: 'waiting' as const, reservationRevision: decision.reservationRevision }
    : decision;
  return { ...plan, externalLoadReservation };
}

function hasExternalCapacity(context: PlanContext, axes: RestoreHeadroomAxes): boolean {
  if (axes.capacity.kind === 'off' && axes.grid.kind === 'off') return false;
  if (context.capacity.kind === 'on'
    && (!context.capacityPeriodCoverageComplete || context.usedKWh >= context.budgetKWh)) {
    return false;
  }
  const lowest = minLimitHeadroom(axes.capacity, axes.grid, axes.budget);
  return lowest.kind === 'on' && lowest.kw >= 0;
}

function resolvePhaseEvidence(
  reading: MeasuredPowerReading,
  mainFuse: MainFuse,
  { phase }: RestoreHeadroomAxes,
): ExternalLoadReadyEvidence['phaseEvidence'] | null {
  if (mainFuse.kind === 'off' || mainFuse.supply !== 'three_phase_neutral') return { kind: 'not_required' };
  if (phase.kind === 'off' || reading.phaseReading.kind !== 'healthy') return null;
  if (!Object.values(phase.roomKw).every((roomKw) => roomKw >= 0)) return null;
  return { kind: 'observed', sampledAtMs: reading.phaseReading.acceptedAtMs };
}
