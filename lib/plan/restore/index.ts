import {
  applyLastResortRestorePass, applyOpportunisticLastResortRestore, getNextLastResortRestores, markUnrestoredLastResort,
  type LastResortRestoreCandidate,
} from './lastResort';
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState, StorageLeverState } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';
import type { SheddingPlan } from '../shedding/types';
import {
  getOnDevices,
  getRestoreCandidates,
  getStorageHandBackCandidates,
  sortRestoreCandidates,
} from './devices';
import { markSteppedDevicesStayAtCurrentLevel } from './helpers';
import type { RestoreTiming } from './timing';
import {
  buildRestoreTiming,
  hasUnsettledLastResortStart,
  buildRestoreCooldownReason,
  resolveMeterSettlingReason,
  shouldPlanBudgetExemptRestores,
  shouldPlanRestores,
} from './timing';
import { applyBudgetExemptRestorePass } from './exemptRestoreLane';
import { buildReservedForStartReason, resolveHeadroomReserves, resolveRestoreDecisionPhase } from '../admission';
import { buildRestoreHeadroomLedger, type RestoreHeadroomLedger } from './headroomLedger';
import { resolvePhaseRoomAxis } from '../phase/phaseRoom';
import { withChargingPhaseOffCandidates } from './chargingPhaseRestore';
import { phaseExportRoomKw } from '../phase/phasePower';
import { buildDisabledRestoreBatchState, buildRestoreBatchState } from './batch';
import {
  resolveAcknowledgedStepUpReservationKw, resolveRunningInstallationReservationKw,
} from '../planSteppedRestorePending';
import { resolveCapacityAdmissionHeadroom } from '../planBudget';
import { accountForAvailablePowerDevices, drawIncludedInMeter, yieldAvailablePower } from './availablePowerDevices';
import {
  markOffDevicesStayOff,
  markRestoreCandidatesHeld,
  markRestoreCandidatesStayShedForShortfall,
} from './marking';
import { applyRestoreLanes } from './candidateLoop';
import type {
  RestoreCycle,
  RestoreDeps,
  RestoreLane,
  RestorePlanResult,
} from './types';

export type { RestoreDeps, RestorePlanResult } from './types';

type RestorePass =
  | { kind: 'last_resort'; target: LastResortRestoreCandidate; hold: DeviceReason }
  | { kind: 'last_resort_wait'; hold: DeviceReason; useOrdinaryWaitReasons: boolean }
  | { kind: 'full'; aboveLimit: LastResortRestoreCandidate | undefined }
  | { kind: 'shortfall' | 'budget_exempt' | 'waiting' };

/** The last-resort facts the pass is chosen from: a relay start in flight, and the relay due its turn. */
type LastResortRestoreState = {
  pending: boolean;
  target: LastResortRestoreCandidate | undefined;
  /** A relay above the admission ceiling: tried without a hold when nothing else has the turn. */
  aboveLimit: LastResortRestoreCandidate | undefined;
};

function resolveRestorePass(
  lastResort: LastResortRestoreState,
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  timing: RestoreTiming,
  effectiveTiming: RestoreTiming,
  shedding: SheddingPlan,
): RestorePass {
  if (shedding.guardInShortfall) return { kind: 'shortfall' };
  const plannable = shouldPlanRestores(shedding.sheddingActive, effectiveTiming, state.capacityPeriodSpentFor(context));
  // The budget-exempt lane keeps the raw startup stabilization.
  const exemptPlannable = shouldPlanBudgetExemptRestores(context, power, state, timing, shedding.sheddingActive);
  const useOrdinaryWaitReasons = !plannable && !exemptPlannable;
  if (lastResort.pending || hasUnsettledLastResortStart(state.actuation, timing)) {
    return { kind: 'last_resort_wait', useOrdinaryWaitReasons, hold: { code: PLAN_REASON_CODES.meterSettling } };
  }
  const { target } = lastResort;
  if (target !== undefined) {
    const hold = buildReservedForStartReason(target.name);
    if (plannable) return { kind: 'last_resort', target, hold };
    return { kind: 'last_resort_wait', useOrdinaryWaitReasons, hold };
  }
  if (plannable) return { kind: 'full', aboveLimit: lastResort.aboveLimit };
  if (exemptPlannable) return { kind: 'budget_exempt' };
  return { kind: 'waiting' };
}

function restorePassServes(pass: RestorePass, target: DevicePlanDevice): boolean {
  switch (pass.kind) {
    case 'full': return true;
    case 'budget_exempt': return target.budgetExempt;
    case 'last_resort': return pass.target.id === target.id;
    default: return false;
  }
}

export function applyRestorePlan(
  planDevices: DevicePlanDevice[],
  context: PlanContext,
  power: MeasuredPower,
  state: PlanEngineState,
  /** The holds PELS keeps on home batteries after this build's limit step (`StorageRelief.levers`). */
  storageLevers: Readonly<Record<string, StorageLeverState>>,
  /** This cycle's shedding decision: its latch and whether the capacity guard is in shortfall. */
  sheddingPlan: SheddingPlan,
  deps: RestoreDeps,
): RestorePlanResult {
  const { sheddingActive, guardInShortfall } = sheddingPlan;
  const deviceMap = new Map(planDevices.map((dev) => [dev.id, dev]));
  const timing = buildRestoreTiming(state, power.headroom, deps, planDevices, context.nowTs);
  const effectiveTiming = resolveEffectiveTiming(timing, context);
  const lastResort: LastResortRestoreState = {
    pending: planDevices.some((device) => device.lastResort && device.binaryCommandPending),
    ...getNextLastResortRestores(planDevices, deps.admissionCeiling),
  };
  const pass = resolveRestorePass(lastResort, context, power, state, timing, effectiveTiming, sheddingPlan);
  // Only the lane that can actually consider a target spends its reservation window.
  state.swapLedger.reconcile(deviceMap, timing.nowTs, (target) => restorePassServes(pass, target), deps.structuredLog);
  const headroomReserves = resolveHeadroomReserves(
    planDevices, state, context, pass.kind === 'full' || pass.kind === 'budget_exempt',
  );

  const restoredThisCycle = new Set<string>();
  const storageHandedBack = new Set<string>();
  const ledger = buildCycleHeadroomLedger(power, context);
  reservePendingChargingPhases(ledger, state, deviceMap);
  reserveAuthorizedPower(ledger, planDevices);
  const availablePowerDevices = accountForAvailablePowerDevices(deviceMap, ledger, drawIncludedInMeter(deps));
  const batchState = context.grid.kind === 'on' ? buildDisabledRestoreBatchState() : buildRestoreBatchState({
    timing: effectiveTiming,
    availableHeadroom: ledger.summaryAvailableKw(),
  });

  // The pass, as every stage of it sees the pass. Built once here from the
  // values above; the lanes derive from it rather than re-listing it.
  const cycle: RestoreCycle = {
    state,
    deps,
    deviceMap,
    swapLedger: state.swapLedger,
    timing: effectiveTiming,
    restoredThisCycle,
    storageHandedBack,
    storageLevers,
    storageHandBackWaitingAt: Number.POSITIVE_INFINITY,
    headroomReserves,
    batchState,
    phase: resolveRestoreDecisionPhase(state.currentRebuildTrigger),
    readPhaseRoom: () => ledger.axes().phase,
    readPhaseExportRoomKw: (phaseName) => phaseExportRoomKw(power.phase, phaseName),
  };

  const restoredOneThisCycle = applyResolvedRestorePass(pass, cycle, ledger, sheddingActive);
  markUnrestoredLastResort(cycle, guardInShortfall || sheddingActive);
  yieldAvailablePower(deviceMap, availablePowerDevices, ledger);
  return {
    planDevices: Array.from(deviceMap.values()),
    restoredThisCycle,
    storageHandedBack,
    availableHeadroom: ledger.summaryAvailableKw(),
    headroomAxes: ledger.axes(),
    headroomReserves,
    lastResortPriorityHold: 'hold' in pass ? pass.hold : null,
    restoredOneThisCycle,
    timing: effectiveTiming,
  };
}

function applyResolvedRestorePass(
  pass: RestorePass, cycle: RestoreCycle, ledger: RestoreHeadroomLedger, sheddingActive: boolean,
): boolean {
  switch (pass.kind) {
    case 'shortfall':
      markRestoreCandidatesStayShedForShortfall(cycle.deviceMap);
      return false;
    case 'last_resort': {
      const restored = applyLastResortRestorePass(cycle, ledger, pass.target);
      markRestoreCandidatesHeld(cycle.deviceMap, cycle.swapLedger, pass.hold);
      return restored;
    }
    case 'last_resort_wait':
      if (!pass.useOrdinaryWaitReasons || !markRestoreLanesWaiting(cycle, sheddingActive)) {
        markRestoreCandidatesHeld(cycle.deviceMap, cycle.swapLedger, pass.hold);
      }
      return false;
    case 'full':
      if (pass.aboveLimit !== undefined && applyOpportunisticLastResortRestore(cycle, ledger, pass.aboveLimit)) {
        markRestoreCandidatesHeld(cycle.deviceMap, cycle.swapLedger, buildReservedForStartReason(pass.aboveLimit.name));
        return true;
      }
      return applyFullRestorePass(cycle, ledger, false).restoredOneThisCycle;
    case 'budget_exempt':
      return applyBudgetExemptRestorePass(cycle, ledger, false).restoredOneThisCycle;
    case 'waiting':
      markRestoreLanesWaiting(cycle, sheddingActive);
      return false;
    default:
      return false;
  }
}

function markRestoreLanesWaiting(cycle: RestoreCycle, sheddingActive: boolean): boolean {
  const { timing } = cycle;
  // A deficit too small to latch shedding is still an overshoot: nothing resumes against it.
  if (sheddingActive || timing.activeOvershoot || timing.inCooldown || timing.inStartupStabilization) {
    markOffDevicesStayOff(cycle);
    markSteppedDevicesStayAtCurrentLevel(cycle);
    return true;
  }
  if (timing.inRestoreCooldown) {
    applyRestorePlanInCooldown(cycle);
    return true;
  }
  return false;
}

/**
 * Keep startup stabilization when capacity binds or grid control is enabled.
 * Otherwise rebuild the shed window from the remaining timing gates.
 */
function resolveEffectiveTiming(timing: RestoreTiming, context: PlanContext): RestoreTiming {
  const hasPhysicalLimit = (context.binding.kind === 'bound' && context.binding.source === 'capacity')
    || context.grid.kind === 'on';
  if (timing.inStartupStabilization && hasPhysicalLimit) return timing;
  return {
    ...timing,
    inStartupStabilization: false,
    startupStabilizationRemainingSec: null,
    inShedWindow: timing.inCooldown || timing.activeOvershoot || timing.inRestoreCooldown,
  };
}

function reservePendingChargingPhases(
  ledger: RestoreHeadroomLedger, state: PlanEngineState, deviceMap: ReadonlyMap<string, DevicePlanDevice>,
): void {
  for (const [deviceId, debit] of state.chargingPhaseCycle.pendingDebits()) {
    const device = deviceMap.get(deviceId);
    // A retained hand-back obligation may outlive managed-device admission.
    ledger.commitPhaseVector({ budgetExempt: device?.budgetExempt ?? false }, debit);
  }
}

// Per-axis available-power ledger for this cycle. Pending-restore reservations
// represent physical draw about to arrive, so they debit every admission axis
// equally (the shortfall guard skips the reservation exactly as it skipped the
// old binding-scalar path).
// Inside the end-of-hour drain the capacity axis is the room under the next
// hour's target only (`resolveCapacityAdmissionHeadroom`): an increase then
// runs into the next hour, and shedding keeps the drain pace itself.
function buildCycleHeadroomLedger(power: MeasuredPower, context: PlanContext): RestoreHeadroomLedger {
  // No pending-restore reservation. It existed to hold back headroom for a restore
  // the meter had not seen yet — but a rebuild is TRIGGERED by a reading
  // (`planRebuildTrigger.ts`), and the reservation was released by
  // `measurementTs > lastRestoreMs`. The same event that lets the planner decide
  // again is the one that retires the hold, so it could never bind across builds;
  // within a build, admitted need is already capped by the batch ledger's
  // `maxNeedKw`. OWNER RULING 2026-08-28: assume new plan = new power sample and
  // drop it (`notes/state-management/actuation-clocks-and-settle.md`).
  return buildRestoreHeadroomLedger({
    capacity: resolveCapacityAdmissionHeadroom(context, power.capacityHeadroom),
    grid: power.gridHeadroom,
    budget: power.budgetHeadroom,
    phase: resolvePhaseRoomAxis(power.phase),
  });
}

// An acknowledged step-up's unarrived watts are draw about to arrive that the
// meter cannot show yet. Unlike an unacknowledged one, it does not hold other
// restores back (`restore/coordination.ts`), so it is debited from every axis
// before any candidate is admitted, whatever its place in the priority order.
function reserveAuthorizedPower(ledger: RestoreHeadroomLedger, planDevices: readonly DevicePlanDevice[]): void {
  for (const device of planDevices) {
    ledger.commit(device, Math.max(
      resolveAcknowledgedStepUpReservationKw(device), resolveRunningInstallationReservationKw(device),
    ));
  }
}

// The ordinary unrestricted restore pass (the shouldPlanRestores branch of
// applyRestorePlan), extracted to keep that function within the line ceiling.
function applyFullRestorePass(
  cycle: RestoreCycle,
  ledger: RestoreHeadroomLedger,
  restoredOne: boolean,
): { restoredOneThisCycle: boolean } {
  const { deviceMap, deps } = cycle;
  const snapshot = Array.from(deviceMap.values());
  // A battery PELS holds for the limit is handed back here, at its place in
  // the same priority order (`storageHandBack.ts`).
  const restoreCandidates = sortRestoreCandidates([
    ...withChargingPhaseOffCandidates(
      snapshot, getRestoreCandidates(snapshot, cycle.state.shedDecisions), cycle.state.chargingPhaseCycle,
    ),
    ...getStorageHandBackCandidates(snapshot, cycle.storageLevers),
  ]);
  const lane: RestoreLane = {
    onDevices: getOnDevices(snapshot, deps.getShedBehavior, deps.temperatureSetpoints),
  };
  return applyRestoreLanes(cycle, lane, restoreCandidates, ledger, restoredOne);
}

/**
 * The inRestoreCooldown branch of applyRestorePlan, reached only without an
 * overshoot. Nothing is admitted; every restore candidate is told which timer
 * holds it — the meter-settling window while the last restore's draw is still
 * unseen by the meter, the restore cooldown after that. Which of the held
 * devices resumes first is settled once on the finished plan
 * (`planRestoreCooldownCohort.ts`), from the admission order; the planner no
 * longer runs a second, hypothetical admission pass to find out.
 */
function applyRestorePlanInCooldown(cycle: RestoreCycle): void {
  const { deviceMap, swapLedger, state, timing } = cycle;
  const holdReason = resolveMeterSettlingReason(timing, state.actuation.lastRestoreMs)
    ?? buildRestoreCooldownReason(timing);
  markRestoreCandidatesHeld(deviceMap, swapLedger, holdReason);
}
