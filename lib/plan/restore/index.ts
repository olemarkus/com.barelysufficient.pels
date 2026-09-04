import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import type { MeasuredPower, PlanContext } from '../planContext';
import {
  buildSwapState,
  cleanupCompletedSwaps,
  cleanupStaleSwaps,
  exportSwapState,
} from '../swap';
import {
  getOnDevices,
  getRestoreCandidates,
  getSteppedRestoreCandidates,
  isActiveSteppedRestoreCandidate,
  markOffDevicesStayOff,
} from './devices';
import {
  markSteppedDevicesStayAtCurrentLevel,
  setRestorePlanDevice as setDevice,
} from './helpers';
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
import { markOffDevicesMeterSettling, markRestoreCandidatesStayShedForShortfall } from './marking';
import { buildMeterSettlingReason } from '../planReasonStrings';
import { holdPendingSwapTargetUntilSourcesAreOff } from './swap';
import {
  applyActiveSteppedRestoreCandidates,
  applyRestoreCandidates,
  buildSteppedSwapExecutor,
} from './candidateLoop';
import type {
  RestoreCooldownPreview,
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
  const swapState = buildSwapState(state);
  const headroomReserves = resolveCycleHeadroomReserves(planDevices, state);
  const timing = buildRestoreTiming(state, power.headroomKw, deps.powerTracker);
  const capacityStartupStabilization = timing.inStartupStabilization && context.softLimitSource === 'capacity';
  const effectiveTiming = capacityStartupStabilization
    ? timing
    : {
        ...timing,
        inStartupStabilization: false as const,
        startupStabilizationRemainingSec: null,
        inShedWindow: timing.inCooldown || timing.activeOvershoot || timing.inRestoreCooldown,
      };
  cleanupStaleSwaps(swapState, deps.structuredLog);
  cleanupCompletedSwaps(swapState, deviceMap);

  const restoredThisCycle = new Set<string>();
  const ledger = buildCycleHeadroomLedger(power);
  let restoredOneThisCycle = false;
  let restoreCooldownPreview: RestoreCooldownPreview | null = null;
  const batchState = buildRestoreBatchState({
    timing: effectiveTiming,
    availableHeadroom: ledger.summaryAvailableKw(),
  });

  // The pass, as every stage of it sees the pass. Built once here from the
  // values above; the lanes derive from it (the cooldown preview swaps in its
  // own timing, batch state and admission mode) rather than re-listing it.
  const cycle: RestoreCycle = {
    state,
    deps,
    deviceMap,
    swapState,
    timing: effectiveTiming,
    restoredThisCycle,
    headroomReserves,
    batchState,
    admissionMode: { kind: 'apply' },
    phase: resolveRestoreDecisionPhase(state.currentRebuildTrigger),
  };

  if (guardInShortfall) {
    markRestoreCandidatesStayShedForShortfall({
      deviceMap,
      headroomKw: power.headroomKw,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
    });
  } else if (shouldPlanRestores(sheddingActive, effectiveTiming, state.hourlyBudgetExhausted)) {
    ({ restoredOneThisCycle } = applyFullRestorePass(cycle, ledger, restoredOneThisCycle));
  } else if (shouldPlanBudgetExemptRestores({
    sheddingActive,
    softLimitSource: context.softLimitSource,
    capacityHeadroomKw: power.capacityHeadroomKw,
    hourlyBudgetExhausted: state.hourlyBudgetExhausted,
    // Raw timing on purpose: under daily source effectiveTiming clears the
    // startup-stabilization hold, but this lane runs while shedding is latched
    // — keep the conservative hold there.
    timing,
  })) {
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
      getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    });
    markSteppedDevicesStayAtCurrentLevel({
      deviceMap,
      timing: effectiveTiming,
      getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    });
  } else if (effectiveTiming.inRestoreCooldown) {
    ({ restoredOneThisCycle, restoreCooldownPreview } = applyRestorePlanInCooldown(
      cycle, ledger, restoredOneThisCycle,
    ));
  }

  return {
    planDevices: Array.from(deviceMap.values()),
    stateUpdates: exportSwapState(swapState),
    restoredThisCycle,
    availableHeadroom: ledger.summaryAvailableKw(),
    ...ledger.axes(),
    headroomReserves,
    restoreCooldownPreview,
    restoredOneThisCycle,
    ...effectiveTiming,
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

// Handles the inRestoreCooldown branch of applyRestorePlan, extracted to keep that function's
// cognitive complexity within the allowed ceiling.
function applyRestorePlanInCooldown(
  cycle: RestoreCycle,
  ledger: RestoreHeadroomLedger,
  restoredOneThisCycle: boolean,
): { restoredOneThisCycle: boolean; restoreCooldownPreview: RestoreCooldownPreview | null } {
  const { deviceMap, swapState, state, deps } = cycle;
  const effectiveTiming = cycle.timing;
  const onDevices = getOnDevices(
    Array.from(deviceMap.values()), deps.getShedBehavior, deps.normalizedShedFloorCByDevice,
  );
  const lane: RestoreLane = {
    onDevices,
    steppedSwapExecutor: buildSteppedSwapExecutor(cycle, onDevices),
  };
  const meterSettlingRemainingSec = resolveMeterSettlingRemainingSec({
    timing: effectiveTiming,
    lastRestoreTs: state.lastRestoreMs,
  });
  if (meterSettlingRemainingSec !== null) {
    markOffDevicesMeterSettling({ deviceMap, timing: effectiveTiming, lastRestoreTs: state.lastRestoreMs });
    const reason = buildMeterSettlingReason(
      meterSettlingRemainingSec,
      resolveMeterSettlingCountdownTiming({
        timing: effectiveTiming,
        lastRestoreTs: state.lastRestoreMs,
      }),
    );
    const steppedCandidates = getSteppedRestoreCandidates(Array.from(deviceMap.values()))
      .filter((dev) => isActiveSteppedRestoreCandidate(dev));
    for (const dev of steppedCandidates) {
      if (holdPendingSwapTargetUntilSourcesAreOff(swapState, dev, deviceMap)) continue;
      setDevice(deviceMap, dev.id, { reason });
    }
    return {
      restoredOneThisCycle,
      restoreCooldownPreview: {
        holdReason: reason,
        selectedOne: false,
        appliesToAllCandidates: true,
        ...ledger.axes(),
      },
    };
  }

  const holdReason = resolveCapacityRestoreBlockReason({ timing: effectiveTiming });
  if (holdReason === null) {
    return {
      restoredOneThisCycle,
      restoreCooldownPreview: null,
    };
  }

  // Preview the ordinary direct-admission path with the global cooldown lifted. The preview
  // writes hold reasons, never restore intents or swaps. It uses a private ledger and batch
  // state so the hypothetical cohort cannot consume power from later planning stages.
  const previewTiming = { ...effectiveTiming, inRestoreCooldown: false as const };
  const previewLedger = buildRestoreHeadroomLedger(ledger.axes());
  const previewBatchState = buildRestoreBatchState({
    timing: previewTiming,
    availableHeadroom: previewLedger.summaryAvailableKw(),
  });
  // The preview is the same pass with three things swapped: a lifted cooldown,
  // a private ledger/batch state so the hypothetical cohort cannot spend real
  // power, and an admission mode that writes hold reasons instead of intents.
  const previewCycle: RestoreCycle = {
    ...cycle,
    timing: previewTiming,
    batchState: previewBatchState,
    admissionMode: { kind: 'cooldown_preview', holdReason },
  };
  const snapshot = Array.from(deviceMap.values());
  const previewLane: RestoreLane = {
    onDevices: getOnDevices(snapshot, deps.getShedBehavior, deps.normalizedShedFloorCByDevice),
    steppedSwapExecutor: lane.steppedSwapExecutor,
  };
  let previewAdmitted = false;
  ({ restoredOneThisCycle: previewAdmitted } = applyRestoreCandidates(
    previewCycle, previewLane, getRestoreCandidates(snapshot), previewLedger, previewAdmitted,
  ));
  ({ restoredOneThisCycle: previewAdmitted } = applyActiveSteppedRestoreCandidates(
    previewCycle, previewLane, previewLedger, previewAdmitted,
  ));
  return {
    restoredOneThisCycle,
    restoreCooldownPreview: {
      holdReason,
      selectedOne: previewAdmitted,
      appliesToAllCandidates: false,
      ...previewLedger.axes(),
    },
  };
}
