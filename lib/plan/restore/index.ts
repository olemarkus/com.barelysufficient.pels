import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState, StorageLeverState } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';
import {
  getOnDevices,
  getRestoreCandidates,
  getStorageHandBackCandidates,
  markOffDevicesStayOff,
  sortRestoreCandidates,
} from './devices';
import {
  markSteppedDevicesStayAtCurrentLevel,
  setRestorePlanDevice as setDevice,
} from './helpers';
import type { RestoreTiming } from './timing';
import {
  buildRestoreTiming,
  buildRestoreCooldownReason,
  resolveMeterSettlingCountdownTiming,
  resolveMeterSettlingRemainingSec,
  shouldPlanBudgetExemptRestores,
  shouldPlanRestores,
} from './timing';
import { applyBudgetExemptRestorePass } from './exemptRestoreLane';
import { resolveHeadroomReserves, resolveRestoreDecisionPhase, type HeadroomReserve } from '../admission';
import { buildRestoreHeadroomLedger, type RestoreHeadroomLedger } from './headroomLedger';
import { buildDisabledRestoreBatchState, buildRestoreBatchState } from './batch';
import { markRestoreCandidatesHeld, markRestoreCandidatesStayShedForShortfall } from './marking';
import { buildMeterSettlingReason } from '../planReasonStrings';
import {
  applyActiveSteppedRestoreCandidates,
  applyRestoreCandidates,
  buildSteppedSwapExecutor,
} from './candidateLoop';
import type {
  RestoreCycle,
  RestoreDeps,
  RestoreLane,
  RestorePlanResult,
} from './types';

export type { RestoreDeps, RestorePlanResult } from './types';

export function applyRestorePlan(params: {
  planDevices: DevicePlanDevice[];
  context: PlanContext;
  power: MeasuredPower;
  state: PlanEngineState;
  /** The holds PELS keeps on home batteries after this build's limit step (`StorageRelief.levers`). */
  storageLevers: Readonly<Record<string, StorageLeverState>>;
  sheddingActive: boolean;
  guardInShortfall?: boolean;
  deps: RestoreDeps;
}): RestorePlanResult {
  const {
    planDevices, context, power, state, storageLevers, sheddingActive, guardInShortfall = false, deps,
  } = params;
  const deviceMap = new Map(planDevices.map((dev) => [dev.id, dev]));
  const swapLedger = state.swapLedger;
  const headroomReserves = resolveCycleHeadroomReserves(planDevices, state);
  const timing = buildRestoreTiming(state, power.headroomKw, deps.powerTracker);
  const effectiveTiming = resolveEffectiveTiming(timing, context);
  // Resolved BEFORE the ledger reconcile and reused by the branch below, so the
  // one thing that decides whether restores happen this cycle also decides
  // whether a waiting swap reservation is charged for it. Ordering used to
  // carry that relationship implicitly: cleanup ran here and the gate was
  // re-evaluated thirty lines down, with nothing connecting them.
  const restoresPlannable = !guardInShortfall
    && shouldPlanRestores(sheddingActive, effectiveTiming, state.hourlyBudgetExhausted);
  // The exempt lane admits restores too, and reaches `blockingTarget` through
  // `applyRestoreCandidates` — so a cycle it runs in is serviceable for a
  // reservation whose target that lane can actually consider.
  // Raw timing keeps startup stabilization while the budget-shedding latch is active.
  const exemptRestoresPlannable = !guardInShortfall
    && shouldPlanBudgetExemptRestores(context, power, state, timing, sheddingActive);
  // Per target, not once per cycle: the exempt lane filters its candidates to
  // budget-exempt devices (`exemptRestoreLane.ts`), so counting it as
  // serviceable for a NON-exempt reservation would burn that reservation's
  // window against a lane that could never consider its target.
  const laneServes = (target: DevicePlanDevice): boolean => (
    restoresPlannable || (exemptRestoresPlannable && target.budgetExempt === true)
  );
  swapLedger.reconcile(deviceMap, timing.nowTs, laneServes, deps.structuredLog);

  const restoredThisCycle = new Set<string>();
  const storageHandedBack = new Set<string>();
  const ledger = buildCycleHeadroomLedger(power);
  let restoredOneThisCycle = false;
  const batchState = context.gridImportLimitKw !== null ? buildDisabledRestoreBatchState() : buildRestoreBatchState({
    timing: effectiveTiming,
    availableHeadroom: ledger.summaryAvailableKw(),
  });

  // The pass, as every stage of it sees the pass. Built once here from the
  // values above; the lanes derive from it rather than re-listing it.
  const cycle: RestoreCycle = {
    state,
    deps,
    deviceMap,
    swapLedger,
    timing: effectiveTiming,
    restoredThisCycle,
    storageHandedBack,
    storageLevers,
    storageHandBackWaitingAt: Number.POSITIVE_INFINITY,
    headroomReserves,
    batchState,
    phase: resolveRestoreDecisionPhase(state.currentRebuildTrigger),
  };

  if (guardInShortfall) {
    markRestoreCandidatesStayShedForShortfall({
      deviceMap,
      headroomKw: power.headroomKw,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
    });
  } else if (restoresPlannable) {
    ({ restoredOneThisCycle } = applyFullRestorePass(cycle, ledger, restoredOneThisCycle));
  } else if (exemptRestoresPlannable) {
    ({ restoredOneThisCycle } = applyBudgetExemptRestorePass(cycle, ledger, restoredOneThisCycle));
  } else if (
    sheddingActive
    // A deficit too small to latch shedding is still an overshoot: nothing
    // resumes against it (`shedding/AGENTS.md` § "Declining to shed is not
    // deciding there is no overshoot").
    || effectiveTiming.activeOvershoot
    || timing.inCooldown
    || effectiveTiming.inStartupStabilization
  ) {
    markOffDevicesStayOff({
      deviceMap,
      timing: effectiveTiming,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
      getLastControlledMs: (deviceId) => state.actuation.lastDeviceControlledMs[deviceId],
    });
    markSteppedDevicesStayAtCurrentLevel({
      deviceMap,
      timing: effectiveTiming,
      getLastControlledMs: (deviceId) => state.actuation.lastDeviceControlledMs[deviceId],
    });
  } else if (effectiveTiming.inRestoreCooldown) {
    applyRestorePlanInCooldown(cycle);
  }

  return {
    planDevices: Array.from(deviceMap.values()),
    restoredThisCycle,
    storageHandedBack,
    availableHeadroom: ledger.summaryAvailableKw(),
    ...ledger.axes(),
    headroomReserves,
    restoredOneThisCycle,
    timing: effectiveTiming,
  };
}

/**
 * Keep startup stabilization when capacity binds or grid control is enabled.
 * Otherwise rebuild the shed window from the remaining timing gates.
 */
function resolveEffectiveTiming(timing: RestoreTiming, context: PlanContext): RestoreTiming {
  const hasPhysicalLimit = context.softLimitSource === 'capacity' || context.gridImportLimitKw !== null;
  if (timing.inStartupStabilization && hasPhysicalLimit) return timing;
  return {
    ...timing,
    inStartupStabilization: false,
    startupStabilizationRemainingSec: null,
    inShedWindow: timing.inCooldown || timing.activeOvershoot || timing.inRestoreCooldown,
  };
}

// Per-axis available-power ledger for this cycle. Pending-restore reservations
// represent physical draw about to arrive, so they debit every admission axis
// equally (the shortfall guard skips the reservation exactly as it skipped the
// old binding-scalar path).
function buildCycleHeadroomLedger(power: MeasuredPower): RestoreHeadroomLedger {
  // No pending-restore reservation. It existed to hold back headroom for a restore
  // the meter had not seen yet — but a rebuild is TRIGGERED by a reading
  // (`planRebuildTrigger.ts`), and the reservation was released by
  // `measurementTs > lastRestoreMs`. The same event that lets the planner decide
  // again is the one that retires the hold, so it could never bind across builds;
  // within a build, admitted need is already capped by the batch ledger's
  // `maxNeedKw`. OWNER RULING 2026-08-28: assume new plan = new power sample and
  // drop it (`notes/state-management/actuation-clocks-and-settle.md`).
  return buildRestoreHeadroomLedger({
    capacityAvailableKw: power.capacityHeadroomKw,
    gridAvailableKw: power.gridHeadroomKw,
    budgetAvailableKw: power.budgetHeadroomKw,
  });
}

// Startup reservations for this cycle: power a higher-priority device is holding back until it
// reaches its lowest active step. Resolved once per restore pass (the call also re-stamps the
// arming clock) and handed to the admission gates, which subtract it per candidate by priority.
function resolveCycleHeadroomReserves(
  planDevices: DevicePlanDevice[],
  state: PlanEngineState,
): HeadroomReserve[] {
  return resolveHeadroomReserves({
    devices: planDevices,
    state,
    nowTs: Date.now(),
  });
}

// The ordinary unrestricted restore pass (the shouldPlanRestores branch of
// applyRestorePlan), extracted to keep that function within the line ceiling.
function applyFullRestorePass(
  cycle: RestoreCycle,
  ledger: RestoreHeadroomLedger,
  restoredOne: boolean,
): { restoredOneThisCycle: boolean } {
  const { deviceMap, deps } = cycle;
  let restoredOneThisCycle = restoredOne;
  const snapshot = Array.from(deviceMap.values());
  // A battery PELS holds for the limit is handed back here, at its place in
  // the same priority order (`storageHandBack.ts`).
  const restoreCandidates = sortRestoreCandidates([
    ...getRestoreCandidates(snapshot, cycle.state.shedDecisions),
    ...getStorageHandBackCandidates(snapshot, cycle.storageLevers),
  ]);
  const onDevices = getOnDevices(snapshot, deps.getShedBehavior, deps.temperatureSetpoints);
  const lane: RestoreLane = {
    onDevices,
    steppedSwapExecutor: buildSteppedSwapExecutor(cycle, onDevices),
  };
  ({ restoredOneThisCycle } = applyRestoreCandidates(
    cycle, lane, restoreCandidates, ledger, restoredOneThisCycle,
  ));
  return applyActiveSteppedRestoreCandidates(cycle, lane, ledger, restoredOneThisCycle);
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
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing,
    lastRestoreTs: state.actuation.lastRestoreMs,
  });
  const holdReason = meterSettlingRemainingSec === null
    ? buildRestoreCooldownReason(timing)
    : buildMeterSettlingReason(
      meterSettlingRemainingSec,
      resolveMeterSettlingCountdownTiming({ timing, lastRestoreTs: state.actuation.lastRestoreMs }),
    );
  markRestoreCandidatesHeld(deviceMap, swapLedger, holdReason);
}
