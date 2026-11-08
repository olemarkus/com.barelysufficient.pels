/**
 * The phase shed pass (`notes/main-fuse.md`): after the scalar selection, for
 * each phase over its share of the main fuse, spend the candidates that touch
 * that phase until its deficit closes. No shed grace: a phase is an
 * instantaneous physical limit.
 */
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PhaseFootprint, PhaseName } from '../../../packages/planner-types/src/phaseFootprint';
import { getDebugEmitter } from '../../logging/logger';
import type { StorageRelief } from '../battery/storageRelief';
import type { MeasuredPower, PlanContext } from '../planContext';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { buildShedCandidateParams, buildSheddingCandidates } from '../shedding/candidates';
import { PENDING_SHED_RELIEF_WINDOW_MS } from '../shedding/pendingRelief';
import { mergeShedDecisions, selectShedDevices, type ShedSelection } from '../shedding/selection';
import { hasStorageInput } from '../battery/storageLadder';
import type {
  ShedCandidate, ShedCandidateParams, SheddingDeps, StorageSetpoint,
} from '../shedding/types';
import type { PhaseMeasurement } from './phasePower';
import { phaseShare } from './phaseRoom';
import { NO_PHASE_SHED_STATE, type PhaseShedDecision } from './phaseShedState';
import { requireLatchedMeterReading } from '../../power/lastTotalPower';

const debug = getDebugEmitter('plan', 'plan');

const PHASE_RELIEF_EPSILON_KW = 0.001;
const PHASE_NAMES: readonly PhaseName[] = ['L1', 'L2', 'L3'];

/** What the scalar selection did this cycle, so the pass neither repeats nor overrides it. */
export type ScalarShedFacts = {
  /** Devices and batteries the scalar selection decided or holds this cycle. */
  decidedIds: ReadonlySet<string>;
  /** Per device, scalar relief decided or in its window that has not been delivered yet. */
  undeliveredKw: ReadonlyMap<string, number>;
};

export type PhaseShedOutcome = Omit<ShedSelection, 'reliefByDevice'> & {
  /** The worst phase still breached with nothing left to limit on it, for the Overview. */
  unrelievedPhase: PhaseName | null;
};

const EMPTY_OUTCOME = (): PhaseShedOutcome => ({
  shedSet: new Set(),
  shedReasons: new Map(),
  shedStepTargets: new Map(),
  storageSetpoints: new Map(),
  unrelievedPhase: null,
});

const touchesPhase = (footprint: PhaseFootprint, phase: PhaseName): boolean => (
  footprint.kind === 'unknown' || phaseShare(footprint, phase) > 0
);

const currentDrawKw = (device: PlanInputDevice): number | null => {
  if (hasStorageInput(device) && device.storage.reading === 'observed') return device.storage.signedPowerW / 1000;
  return isMeteredPlanDevice(device) ? device.currentDrawKw : null;
};

const undeliveredKw = (decision: PhaseShedDecision, drawKw: number): number => (
  Math.min(decision.reliefKw, Math.max(0, drawKw - (decision.drawAtDecisionKw - decision.reliefKw)))
);

type LiveDecision = { deviceId: string; decision: PhaseShedDecision; undeliveredKw: number };

/** Decisions in their window whose device still has relief to deliver. */
function liveDecisions(
  decisions: ReadonlyMap<string, PhaseShedDecision>,
  devices: readonly PlanInputDevice[],
  nowTs: number,
): LiveDecision[] {
  const byId = new Map(devices.map((device) => [device.id, device]));
  return [...decisions].flatMap(([deviceId, decision]) => {
    const device = byId.get(deviceId);
    const drawKw = device === undefined ? null : currentDrawKw(device);
    const inWindow = nowTs - decision.atMs >= 0 && nowTs - decision.atMs < PENDING_SHED_RELIEF_WINDOW_MS;
    if (!inWindow || drawKw === null) return [];
    const undelivered = undeliveredKw(decision, drawKw);
    return undelivered > PHASE_RELIEF_EPSILON_KW ? [{ deviceId, decision, undeliveredKw: undelivered }] : [];
  });
}

/* eslint-disable functional/immutable-data, no-param-reassign -- The pass accumulates one cycle's decision. */
function holdDecision(
  outcome: PhaseShedOutcome,
  live: LiveDecision,
  deviceById: ReadonlyMap<string, PlanInputDevice>,
): void {
  const { deviceId, decision } = live;
  if (decision.setpointW !== undefined) {
    const device = deviceById.get(deviceId);
    if (device !== undefined && hasStorageInput(device) && device.storage.reading === 'observed') {
      outcome.storageSetpoints.set(deviceId, { setpointW: decision.setpointW, banked: true, storage: device.storage });
    }
    return;
  }
  outcome.shedSet.add(deviceId);
  outcome.shedReasons.set(deviceId, decision.reason);
  if (decision.stepId !== undefined) outcome.shedStepTargets.set(deviceId, decision.stepId);
}

type PassCycle = {
  context: PlanContext;
  baseParams: ShedCandidateParams;
  /** Open deficit per phase, kW; only breached phases have an entry. */
  deficits: Map<PhaseName, number>;
  excluded: Set<string>;
  outcome: PhaseShedOutcome;
  nextDecisions: Map<string, PhaseShedDecision>;
  footprintById: ReadonlyMap<string, PhaseFootprint>;
  drawById: ReadonlyMap<string, number>;
  nowTs: number;
  unknownSpent: boolean;
  /** Phases the pass limited something on this cycle. */
  spentOnPhases: Set<PhaseName>;
};

function candidatesFor(cycle: PassCycle, phase: PhaseMeasurement): ShedCandidate[] {
  const { baseParams, nowTs, excluded, footprintById } = cycle;
  const deficitKw = cycle.deficits.get(phase.phase) ?? 0;
  const storageLimit = baseParams.storageLimit.kind === 'measured'
    ? { ...baseParams.storageLimit, drawKw: phase.drawKw, chargeOnly: true as const }
    : baseParams.storageLimit;
  const { candidates } = buildSheddingCandidates({
    ...baseParams, needed: deficitKw, deficitKw, storageLimit,
  }, nowTs);
  return candidates.filter((candidate) => {
    if (excluded.has(candidate.id)) return false;
    const footprint = footprintById.get(candidate.id);
    return footprint !== undefined && touchesPhase(footprint, phase.phase);
  });
}

function recordSpend(
  cycle: PassCycle,
  candidate: ShedCandidate,
  footprint: PhaseFootprint,
  selection: ShedSelection,
  reason: DeviceReason,
  reliefKw: number,
): void {
  const { nextDecisions, excluded, drawById, nowTs, outcome } = cycle;
  const setpoint: StorageSetpoint | undefined = selection.storageSetpoints.get(candidate.id);
  const stepId = selection.shedStepTargets.get(candidate.id);
  nextDecisions.set(candidate.id, {
    atMs: nowTs,
    reliefKw,
    drawAtDecisionKw: drawById.get(candidate.id) ?? 0,
    footprint,
    reason,
    ...(stepId === undefined ? {} : { stepId }),
    ...(setpoint === undefined ? {} : { setpointW: setpoint.setpointW }),
  });
  excluded.add(candidate.id);
  const merged = mergeShedDecisions(outcome, selection);
  outcome.shedSet = merged.shedSet;
  outcome.shedReasons = merged.shedReasons;
  outcome.shedStepTargets = merged.shedStepTargets;
  outcome.storageSetpoints = merged.storageSetpoints;
}

const deductRelief = (cycle: PassCycle, footprint: PhaseFootprint, reliefKw: number): void => {
  for (const [name, openKw] of cycle.deficits) {
    cycle.deficits.set(name, Math.max(0, openKw - reliefKw * phaseShare(footprint, name)));
  }
};

function spendCandidate(
  cycle: PassCycle,
  phase: PhaseName,
  candidate: ShedCandidate,
  footprint: PhaseFootprint,
  share: number,
): void {
  const deficitKw = cycle.deficits.get(phase) ?? 0;
  const reason: DeviceReason = { code: PLAN_REASON_CODES.phaseLimit, phase };
  const selection = selectShedDevices([candidate], deficitKw / share, reason, false, { kind: 'grid', deficitKw });
  const relief = selection.reliefByDevice.get(candidate.id);
  if (relief === undefined) return;
  recordSpend(cycle, candidate, footprint, selection, reason, relief.creditedKw);
  deductRelief(cycle, footprint, relief.creditedKw);
  cycle.spentOnPhases.add(phase);
  for (const [name] of cycle.deficits) {
    if (phaseShare(footprint, name) > 0) cycle.spentOnPhases.add(name);
  }
}

/** Known footprints first; a single unknown one per cycle may also go, credited nothing. */
function spendPhase(cycle: PassCycle, phase: PhaseMeasurement): boolean {
  const name = phase.phase;
  const candidates = candidatesFor(cycle, phase);
  const isUnknown = (candidate: ShedCandidate): boolean => cycle.footprintById.get(candidate.id)?.kind === 'unknown';
  const open = (): boolean => (cycle.deficits.get(name) ?? 0) > PHASE_RELIEF_EPSILON_KW;
  for (const candidate of candidates.filter((entry) => !isUnknown(entry))) {
    if (!open()) return true;
    const footprint = cycle.footprintById.get(candidate.id) as PhaseFootprint;
    spendCandidate(cycle, name, candidate, footprint, phaseShare(footprint, name));
  }
  if (!open()) return true;
  const unknown = candidates.find(isUnknown);
  if (unknown === undefined) return false;
  if (!cycle.unknownSpent) {
    cycle.unknownSpent = true;
    spendCandidate(cycle, name, unknown, { kind: 'unknown' }, 1);
  }
  return true;
}

/** Relief already on its way, per phase: the larger of the pass's own and the scalar credit, per device. */
function resolvePhaseCredits(
  live: readonly LiveDecision[],
  scalar: ScalarShedFacts,
  footprintById: ReadonlyMap<string, PhaseFootprint>,
): Map<PhaseName, number> {
  const byDevice = new Map(scalar.undeliveredKw);
  for (const entry of live) {
    byDevice.set(entry.deviceId, Math.max(byDevice.get(entry.deviceId) ?? 0, entry.undeliveredKw));
  }
  const credits = new Map<PhaseName, number>();
  for (const [deviceId, kw] of byDevice) {
    const footprint = footprintById.get(deviceId);
    if (footprint === undefined) continue;
    for (const name of PHASE_NAMES) credits.set(name, (credits.get(name) ?? 0) + kw * phaseShare(footprint, name));
  }
  return credits;
}

function resolveDeficits(
  phases: readonly PhaseMeasurement[],
  credits: ReadonlyMap<PhaseName, number>,
): Map<PhaseName, number> {
  return new Map(phases.filter((phase) => phase.breached).map((phase) => (
    [phase.phase, Math.max(0, phase.drawKw - phase.targetKw - (credits.get(phase.phase) ?? 0))]
  )));
}

/** Whether the Overview may say nothing is left: open, nothing happening on it, nothing left to try. */
const isUnrelieved = (
  cycle: PassCycle,
  phase: PhaseName,
  credits: ReadonlyMap<PhaseName, number>,
  live: readonly LiveDecision[],
  hadCandidate: boolean,
): boolean => (
  (cycle.deficits.get(phase) ?? 0) > PHASE_RELIEF_EPSILON_KW
  && !hadCandidate
  && !cycle.spentOnPhases.has(phase)
  && (credits.get(phase) ?? 0) <= PHASE_RELIEF_EPSILON_KW
  && !live.some((entry) => entry.decision.footprint.kind === 'unknown')
);

/**
 * The pass for this cycle. Decisions in their window with undelivered relief are
 * re-asserted so nothing is lost between readings, and their relief is credited
 * before anything new is chosen, as is what the scalar selection has decided and
 * not delivered. A device the scalar pass decided keeps that decision: its phase
 * decision stays for credit only. A rebuild on a sample the pass already spent
 * on holds and adds nothing.
 */
export function runPhaseShedPass(
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  deps: SheddingDeps,
  storage: StorageRelief,
  scalar: ScalarShedFacts,
): PhaseShedOutcome {
  const { nowTs, devices } = context;
  if (power.phase.kind === 'off') {
    state.phaseShed = NO_PHASE_SHED_STATE;
    return EMPTY_OUTCOME();
  }
  const { phases } = power.phase;
  const live = liveDecisions(state.phaseShed.decisions, devices, nowTs);
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const outcome = EMPTY_OUTCOME();
  for (const entry of live) {
    if (!scalar.decidedIds.has(entry.deviceId)) holdDecision(outcome, entry, deviceById);
  }
  const sampleAtMs = requireLatchedMeterReading(deps.powerTracker).atMs;
  if (sampleAtMs === state.phaseShed.spentOnSampleAtMs) {
    state.phaseShed = { ...state.phaseShed, decisions: new Map(live.map((entry) => [entry.deviceId, entry.decision])) };
    return { ...outcome, unrelievedPhase: state.phaseShed.unrelievedPhase };
  }
  const footprintById = new Map(devices.map((device) => [device.id, device.phaseFootprint]));
  const credits = resolvePhaseCredits(live, scalar, footprintById);
  const deficits = resolveDeficits(phases, credits);
  const cycle: PassCycle = {
    context,
    baseParams: {
      ...buildShedCandidateParams(context, power, state, deps, storage),
      bypassRecentRestore: true,
      limitSource: 'grid',
      physicalLimitBreached: true,
    },
    deficits,
    excluded: new Set([...scalar.decidedIds, ...live.map((entry) => entry.deviceId)]),
    outcome,
    nextDecisions: new Map(live.map((entry) => [entry.deviceId, entry.decision])),
    footprintById,
    drawById: new Map(devices.flatMap((device) => {
      const drawKw = currentDrawKw(device);
      return drawKw === null ? [] : [[device.id, drawKw] as const];
    })),
    nowTs,
    // An unknown device earns no credit, so one still responding must hold the next back.
    unknownSpent: live.some((entry) => entry.decision.footprint.kind === 'unknown'),
    spentOnPhases: new Set(),
  };
  const breachedLargestFirst = phases
    .filter((phase) => phase.breached)
    .sort((a, b) => (deficits.get(b.phase) ?? 0) - (deficits.get(a.phase) ?? 0));
  let unrelievedPhase: PhaseName | null = null;
  for (const phase of breachedLargestFirst) {
    const hadCandidate = spendPhase(cycle, phase);
    if (unrelievedPhase === null && isUnrelieved(cycle, phase.phase, credits, live, hadCandidate)) {
      unrelievedPhase = phase.phase;
    }
  }
  const spent = cycle.spentOnPhases.size > 0;
  state.phaseShed = {
    decisions: cycle.nextDecisions,
    spentOnSampleAtMs: spent ? sampleAtMs : state.phaseShed.spentOnSampleAtMs,
    unrelievedPhase,
  };
  debug({
    event: 'plan_phase_shed_pass',
    deficits: Object.fromEntries(deficits),
    held: live.length,
    decisions: cycle.nextDecisions.size,
    unrelievedPhase,
  });
  return { ...outcome, unrelievedPhase };
}
/* eslint-enable functional/immutable-data, no-param-reassign */
