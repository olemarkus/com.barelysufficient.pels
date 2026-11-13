import type { ChargingPhaseVector } from '../../packages/contracts/src/chargingPhases';
import type {
  ChargingPhaseCandidate, ChargingPhaseDebit, ChargingPhaseEnvelope, ChargingPhasePoint,
  ChargingPhaseReservation,
} from '../../packages/planner-types/src/chargingPhases';
import type { ChargingPhaseTaskRequirement } from '../../packages/planner-types/src/deferredDecoration';
import type { ChargingPhasePlanningRead } from '../ports/chargingPhases';
import type { ChargingPhaseDecision } from '../planContract/chargingPhaseDecision';
import type { RestoreHeadroomAxes } from './restore/headroomLedger';
import type { PhaseRoomAxis } from './phase/phaseRoom';
import { computeRestoreBufferKw } from './restore/accounting';
import type { DevicePlanDevice } from './planTypes';
import { getDebugEmitter } from '../logging/logger';

const debug = getDebugEmitter('plan', 'plan');

const PHASES = ['L1', 'L2', 'L3'] as const;
const EPSILON_KW = 0.001;
const ZERO_VECTOR: ChargingPhaseVector = { L1: 0, L2: 0, L3: 0 };

/** Admission still sees the old load until an independent observation replaces it. */
export function chargingPhaseDebit(
  reservation: Pick<ChargingPhaseReservation, 'totalKw' | 'perPhaseKw'>,
  observed: Pick<ChargingPhasePoint, 'totalKw' | 'perPhaseKw'> | undefined,
): ChargingPhaseDebit {
  return {
    totalKw: Math.max(0, reservation.totalKw - (observed?.totalKw ?? 0)),
    perPhaseKw: {
      L1: Math.max(0, reservation.perPhaseKw.L1 - (observed?.perPhaseKw.L1 ?? 0)),
      L2: Math.max(0, reservation.perPhaseKw.L2 - (observed?.perPhaseKw.L2 ?? 0)),
      L3: Math.max(0, reservation.perPhaseKw.L3 - (observed?.perPhaseKw.L3 ?? 0)),
    },
  };
}

/** A rated envelope's geometry is separate from the measured operating point. */
export function chargingPhasePoint(envelope: ChargingPhaseEnvelope, currentA: number): ChargingPhasePoint {
  const totalKw = currentA * envelope.phases * 230 / 1000;
  const footprint = envelope.footprint;
  const perPhaseKw = footprint.kind === 'single'
    ? { ...ZERO_VECTOR, [footprint.phase]: totalKw }
    : { L1: totalKw / 3, L2: totalKw / 3, L3: totalKw / 3 };
  return { phases: envelope.phases, currentA, totalKw, perPhaseKw };
}

/** The immutable budget offered at this device's own ranked turn. */
export type ChargingPhaseAdmission = {
  axes: RestoreHeadroomAxes;
  budgetExempt: boolean;
  /** Absolute solar allocation; absent for ordinary capacity admission. */
  solarKw?: number;
  requirement?: ChargingPhaseTaskRequirement;
  /** Already debited at the start of this cycle, not a second power grant. */
  reserved?: ChargingPhaseReservation;
};

function additionalDebit(
  reservation: Pick<ChargingPhaseReservation, 'totalKw' | 'perPhaseKw'>,
  observed: ChargingPhasePoint,
  reserved: ChargingPhaseReservation | undefined,
): ChargingPhaseDebit {
  if (!reserved) return chargingPhaseDebit(reservation, observed);
  return chargingPhaseDebit(reservation, {
    totalKw: Math.max(observed.totalKw, reserved.totalKw),
    perPhaseKw: {
      L1: Math.max(observed.perPhaseKw.L1, reserved.perPhaseKw.L1),
      L2: Math.max(observed.perPhaseKw.L2, reserved.perPhaseKw.L2),
      L3: Math.max(observed.perPhaseKw.L3, reserved.perPhaseKw.L3),
    },
  });
}

export type AdmittedChargingPhaseOperation = {
  decision: Exclude<ChargingPhaseDecision, { kind: 'release' }>;
  debit: ChargingPhaseDebit;
};

/** A new incoming watt clears the same admission buffer as any other restore. */
export function chargingPhaseAdmissionDebit(debit: ChargingPhaseDebit): ChargingPhaseDebit {
  const buffered = (kw: number): number => kw > EPSILON_KW ? kw + computeRestoreBufferKw(kw) : 0;
  return {
    totalKw: buffered(debit.totalKw),
    perPhaseKw: {
      L1: buffered(debit.perPhaseKw.L1), L2: buffered(debit.perPhaseKw.L2), L3: buffered(debit.perPhaseKw.L3),
    },
  };
}

const axisFits = (axis: RestoreHeadroomAxes['capacity'], kw: number): boolean => (
  kw <= EPSILON_KW || axis.kind === 'off' || kw <= axis.kw + EPSILON_KW
);

function debitFits(debit: ChargingPhaseDebit, admission: ChargingPhaseAdmission): boolean {
  const { axes } = admission;
  const priced = chargingPhaseAdmissionDebit(debit);
  return axisFits(axes.capacity, priced.totalKw) && axisFits(axes.grid, priced.totalKw)
    && (admission.budgetExempt || axisFits(axes.budget, priced.totalKw))
    && (axes.phase.kind === 'off' || PHASES.every((phase) => (
      priced.perPhaseKw[phase] <= EPSILON_KW || (axes.phase.kind === 'on'
        && priced.perPhaseKw[phase] <= axes.phase.roomKw[phase] + EPSILON_KW)
    )));
}

function highestAffordablePoint(
  candidate: ChargingPhaseCandidate, envelope: ChargingPhaseEnvelope, admission: ChargingPhaseAdmission,
): ChargingPhasePoint | undefined {
  if (envelope.footprint.kind !== 'single' && envelope.footprint.kind !== 'all_three') return undefined;
  const currents = envelope.profile.steps.flatMap((step) => (
    step.planningCurrentA !== undefined && step.planningCurrentA >= candidate.minimumCurrentA
      ? [step.planningCurrentA] : []
  ));
  // eslint-disable-next-line functional/immutable-data -- Sorts this new candidate list.
  currents.sort((a, b) => b - a);
  return currents.map((amps) => chargingPhasePoint(envelope, amps)).find((point) => (
    (admission.solarKw === undefined || point.totalKw <= admission.solarKw + EPSILON_KW)
    && debitFits(additionalDebit(point, candidate.observed, admission.reserved), admission)
  ));
}

function maxReservation(
  candidate: ChargingPhaseCandidate, target: ChargingPhasePoint, reserved: ChargingPhaseReservation | undefined,
): ChargingPhaseReservation | undefined {
  const sourceEnvelope = candidate.envelopes.find((entry) => entry.phases === candidate.observed.phases);
  if (!sourceEnvelope) return undefined;
  // Even a cold start may still be on the installed 3p envelope when its force setting echoes 1p.
  const source = chargingPhasePoint(sourceEnvelope, Math.max(target.currentA, candidate.observed.currentA));
  return {
    deviceId: candidate.deviceId,
    totalKw: Math.max(candidate.observed.totalKw, source.totalKw, target.totalKw, reserved?.totalKw ?? 0),
    perPhaseKw: {
      L1: Math.max(
        candidate.observed.perPhaseKw.L1, source.perPhaseKw.L1, target.perPhaseKw.L1,
        reserved?.perPhaseKw.L1 ?? 0,
      ),
      L2: Math.max(
        candidate.observed.perPhaseKw.L2, source.perPhaseKw.L2, target.perPhaseKw.L2,
        reserved?.perPhaseKw.L2 ?? 0,
      ),
      L3: Math.max(
        candidate.observed.perPhaseKw.L3, source.perPhaseKw.L3, target.perPhaseKw.L3,
        reserved?.perPhaseKw.L3 ?? 0,
      ),
    },
  };
}

function fixedPhaseCount(candidate: ChargingPhaseCandidate): 1 | 3 | undefined {
  if (candidate.mode === 'single') return 1;
  if (candidate.mode === 'three') return 3;
  return undefined;
}

/** Pure phase alternative selection, called before the ranked turn collapses its budget to one footprint. */
export function chooseChargingPhaseOperation(
  candidate: ChargingPhaseCandidate, admission: ChargingPhaseAdmission,
): AdmittedChargingPhaseOperation | undefined {
  const points = candidate.envelopes.flatMap((envelope) => {
    const point = highestAffordablePoint(candidate, envelope, admission);
    return point ? [{ envelope, point }] : [];
  });
  const permittedPhases = candidate.forceSinglePhase ? 1 : 3;
  const current = points.find(({ point }) => point.phases === permittedPhases);
  const alternative = points.find(({ point }) => point.phases !== permittedPhases);
  if (!alternative) return undefined;
  const fixed = fixedPhaseCount(candidate);
  if (fixed !== undefined && alternative.point.phases !== fixed) return undefined;
  if (fixed === undefined && current) {
    const required = admission.requirement?.admissionKw;
    // Retain a useful mode unless its alternative increases usable delivery. A deadline's booked
    // power is its own demand; a manual boost never fabricates that requirement.
    if (required !== undefined && current.point.totalKw >= required - EPSILON_KW) return undefined;
    if (alternative.point.totalKw <= current.point.totalKw + EPSILON_KW) return undefined;
  }
  const target = chargingPhasePoint(alternative.envelope, candidate.minimumCurrentA);
  const reservation = maxReservation(candidate, target, admission.reserved);
  if (!reservation) return undefined;
  const debit = additionalDebit(reservation, candidate.observed, admission.reserved);
  if (!debitFits(debit, admission)) return undefined;
  const kind = candidate.observed.currentA > candidate.minimumCurrentA ? 'prepare' : 'switch';
  return { decision: { kind, deviceId: candidate.deviceId, target, reservation }, debit };
}

/** One build's phase decisions and reservations; no timer, device I/O or durable state lives here. */
export class ChargingPhasePlanningCycle {
  private readonly byId: ReadonlyMap<string, ChargingPhaseCandidate>;
  private readonly observations: ReadonlyMap<string, ChargingPhasePoint>;
  private readonly reservations: ReadonlyMap<string, ChargingPhaseReservation>;
  private readonly selected = new Map<string, AdmittedChargingPhaseOperation>();
  private readonly solarOffers = new Map<string, number>();
  private readonly restoreOffers = new Map<string, RestoreHeadroomAxes>();
  private requirements: ReadonlyMap<string, ChargingPhaseTaskRequirement> = new Map();

  constructor(private readonly read: ChargingPhasePlanningRead) {
    this.byId = new Map(read.candidates.map((candidate) => [candidate.deviceId, candidate]));
    this.observations = new Map(read.observations.map((point) => [point.deviceId, point]));
    this.reservations = new Map(read.reservations.map((reservation) => [reservation.deviceId, reservation]));
  }

  setRequirements(requirements: ReadonlyMap<string, ChargingPhaseTaskRequirement>): void {
    this.requirements = requirements;
  }
  hasCandidate(deviceId: string): boolean { return this.byId.has(deviceId); }
  hasDecision(deviceId: string): boolean { return this.selected.has(deviceId); }
  hasSolarOffer(deviceId: string): boolean { return this.solarOffers.has(deviceId); }
  withdrawSolarOffer(deviceId: string): void { this.solarOffers.delete(deviceId); }

  continuationTargetKw(deviceId: string): number | undefined {
    return this.read.continuations.find((decision) => decision.deviceId === deviceId)?.target.totalKw;
  }

  availableSolarKw(deviceId: string, remainingPoolKw: number): number {
    const reservation = this.reservations.get(deviceId);
    const observed = this.observations.get(deviceId) ?? this.byId.get(deviceId)?.observed;
    const incoming = reservation ? chargingPhaseDebit(reservation, observed).totalKw : 0;
    return remainingPoolKw + incoming;
  }
  decline(deviceId: string): void { this.selected.delete(deviceId); }
  hasReservation(deviceId: string): boolean {
    const reservation = this.reservations.get(deviceId);
    return reservation !== undefined && (reservation.totalKw > EPSILON_KW
      || PHASES.some((phase) => reservation.perPhaseKw[phase] > EPSILON_KW));
  }
  offerRestoreBudget(deviceId: string, axes: RestoreHeadroomAxes): void { this.restoreOffers.set(deviceId, axes); }

  aggregateRoom(deviceId: string, budgetExempt: boolean): number | null {
    const axes = this.restoreOffers.get(deviceId);
    if (!axes) return null;
    const enabled = [axes.capacity, axes.grid, ...(budgetExempt ? [] : [axes.budget])]
      .flatMap((axis) => axis.kind === 'on' ? [axis.kw] : []);
    return enabled.length > 0 ? Math.min(...enabled) : null;
  }

  chooseRestore(deviceId: string, budgetExempt: boolean): AdmittedChargingPhaseOperation | undefined {
    const axes = this.restoreOffers.get(deviceId);
    const chosen = axes ? this.choose(deviceId, {
      axes, budgetExempt, solarKw: this.solarOffers.get(deviceId), requirement: this.requirements.get(deviceId),
      reserved: this.reservations.get(deviceId),
    }) : undefined;
    if (this.byId.has(deviceId)) debug({ event: 'charging_phase_admission', deviceId,
      sourcePhases: this.byId.get(deviceId)?.observed.phases, solarKw: this.solarOffers.get(deviceId),
      decision: chosen?.decision.kind ?? 'ordinary', targetPhases: chosen?.decision.target.phases });
    return chosen;
  }

  chooseSurplus(deviceId: string, poolKw: number, room: PhaseRoomAxis): AdmittedChargingPhaseOperation | undefined {
    const candidate = this.byId.get(deviceId);
    if (!candidate) {
      debug({ event: 'charging_phase_solar', deviceId, candidate: false });
      return undefined;
    }
    const reserved = this.reservations.get(deviceId);
    // Its own retained reservation was taken out before the ranked walk. It remains this
    // operation's allocation, not extra solar offered to another consumer.
    const solarKw = this.availableSolarKw(deviceId, poolKw);
    const chosen = chooseChargingPhaseOperation(candidate, {
      axes: { capacity: { kind: 'off' }, grid: { kind: 'off' }, budget: { kind: 'off' }, phase: room },
      budgetExempt: false, solarKw, reserved,
    });
    // Solar reserves at its priority turn; execution still requires the ordinary restore gates.
    if (chosen) this.solarOffers.set(deviceId, solarKw);
    debug({ event: 'charging_phase_solar', deviceId, candidate: true, mode: candidate.mode,
      sourcePhases: candidate.observed.phases, sourceCurrentA: candidate.observed.currentA, solarKw,
      decision: chosen?.decision.kind ?? 'ordinary', targetPhases: chosen?.decision.target.phases });
    return chosen;
  }

  pendingDebits(): ReadonlyMap<string, ChargingPhaseDebit> {
    return new Map(this.read.reservations.map((reservation) => [
      reservation.deviceId, chargingPhaseDebit(reservation, this.observations.get(reservation.deviceId)),
    ]));
  }

  selectedDebit(deviceId: string): ChargingPhaseDebit | undefined {
    const selected = this.selected.get(deviceId);
    return selected ? chargingPhaseAdmissionDebit(selected.debit) : undefined;
  }
  decisions(): ChargingPhaseDecision[] {
    return [...this.read.releases, ...[...this.selected.values()].map((entry) => entry.decision)];
  }

  /** A firmware idle dip is not withdrawn demand; actual safety and standing holds are. */
  finish(devices: readonly DevicePlanDevice[], heldIds: ReadonlySet<string>): ChargingPhaseDecision[] {
    const allowed = new Set(devices.filter((device) => (
      device.control.commandAuthority && device.available !== false
      && !device.externalOffHoldActive && !heldIds.has(device.id)
    )).map((device) => device.id));
    const controls = [
      ...this.read.continuations,
      ...[...this.selected.values()].map((entry) => entry.decision),
    ].filter((decision) => allowed.has(decision.deviceId));
    for (const [deviceId, choice] of this.selected) debug({ event: 'charging_phase_decision', deviceId,
      decision: choice.decision.kind, targetPhases: choice.decision.target.phases,
      admitted: allowed.has(deviceId), held: heldIds.has(deviceId) });
    return [...this.read.releases, ...controls];
  }

  private choose(deviceId: string, admission: ChargingPhaseAdmission): AdmittedChargingPhaseOperation | undefined {
    if (this.selected.has(deviceId)) return undefined;
    const candidate = this.byId.get(deviceId);
    const chosen = candidate ? chooseChargingPhaseOperation(candidate, admission) : undefined;
    if (chosen) this.selected.set(deviceId, chosen);
    return chosen;
  }
}
