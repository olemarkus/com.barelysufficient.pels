import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';
import {
  getOnDevices,
  getRestoreCandidates,
  markOffDevicesStayOff,
} from './devices';
import {
  markSteppedDevicesStayAtCurrentLevel,
  setRestorePlanDevice as setDevice,
} from './helpers';
import type { RestoreTiming } from './timing';
import type { SoftLimitSource } from '../planContext';
import {
  buildRestoreTiming,
  resolveCapacityRestoreBlockReason,
  resolveMeterSettlingCountdownTiming,
  resolveMeterSettlingRemainingSec,
  shouldPlanBudgetExemptRestores,
  shouldPlanRestores,
} from './timing';
import { applyBudgetExemptRestorePass } from './exemptRestoreLane';
import { resolveHeadroomReserves, resolveRestoreDecisionPhase, type HeadroomReserve } from '../admission';
import { buildRestoreHeadroomLedger, type RestoreHeadroomLedger } from './headroomLedger';
import { buildRestoreBatchState } from './batch';
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
  sheddingActive: boolean;
  guardInShortfall?: boolean;
  deps: RestoreDeps;
}): RestorePlanResult {
  const { planDevices, context, power, state, sheddingActive, guardInShortfall = false, deps } = params;
  const deviceMap = new Map(planDevices.map((dev) => [dev.id, dev]));
  const swapLedger = state.swapLedger;
  const headroomReserves = resolveCycleHeadroomReserves(planDevices, state);
  const timing = buildRestoreTiming(state, power.headroomKw, deps.powerTracker);
  const effectiveTiming = resolveEffectiveTiming(timing, context.softLimitSource);
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
  const exemptRestoresPlannable = !guardInShortfall && shouldPlanBudgetExemptRestores({
    sheddingActive,
    softLimitSource: context.softLimitSource,
    capacityHeadroomKw: power.capacityHeadroomKw,
    hourlyBudgetExhausted: state.hourlyBudgetExhausted,
    // Raw timing on purpose: under daily source effectiveTiming clears the
    // startup-stabilization hold, but this lane runs while shedding is latched
    // — keep the conservative hold there.
    timing,
  });
  // Per target, not once per cycle: the exempt lane filters its candidates to
  // budget-exempt devices (`exemptRestoreLane.ts`), so counting it as
  // serviceable for a NON-exempt reservation would burn that reservation's
  // window against a lane that could never consider its target.
  const laneServes = (target: DevicePlanDevice): boolean => (
    restoresPlannable || (exemptRestoresPlannable && target.budgetExempt === true)
  );
  swapLedger.reconcile(deviceMap, timing.nowTs, laneServes, deps.structuredLog);

  const restoredThisCycle = new Set<string>();
  const ledger = buildCycleHeadroomLedger(power);
  let restoredOneThisCycle = false;
  const batchState = buildRestoreBatchState({
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
    availableHeadroom: ledger.summaryAvailableKw(),
    ...ledger.axes(),
    headroomReserves,
    restoredOneThisCycle,
    timing: effectiveTiming,
  };
}

/**
 * The startup-stabilization hold applies only while capacity is the binding
 * axis; under a daily-budget bind it is cleared, and `inShedWindow` is rebuilt
 * from the terms that remain.
 */
function resolveEffectiveTiming(timing: RestoreTiming, softLimitSource: SoftLimitSource): RestoreTiming {
  if (timing.inStartupStabilization && softLimitSource === 'capacity') return timing;
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
  const restoreCandidates = getRestoreCandidates(snapshot);
  const onDevices = getOnDevices(snapshot, deps.getShedBehavior, deps.normalizedShedFloorCByDevice);
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
 * The inRestoreCooldown branch of applyRestorePlan. Nothing is admitted; every
 * restore candidate is told which timer holds it — the meter-settling window
 * while the last restore's draw is still unseen by the meter, the restore
 * cooldown after that. Which of the held devices resumes first is settled once
 * on the finished plan (`planRestoreCooldownCohort.ts`), from the admission
 * order; the planner no longer runs a second, hypothetical admission pass to
 * find out. No hold reason resolves only under
 * an active overshoot, where the shed itself is the cause and the producer's
 * reason stands.
 */
function applyRestorePlanInCooldown(cycle: RestoreCycle): void {
  const { deviceMap, swapLedger, state, timing } = cycle;
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing,
    lastRestoreTs: state.actuation.lastRestoreMs,
  });
  const holdReason = meterSettlingRemainingSec === null
    ? resolveCapacityRestoreBlockReason({ timing })
    : buildMeterSettlingReason(
      meterSettlingRemainingSec,
      resolveMeterSettlingCountdownTiming({ timing, lastRestoreTs: state.actuation.lastRestoreMs }),
    );
  if (holdReason === null) return;
  markRestoreCandidatesHeld(deviceMap, swapLedger, holdReason);
}
