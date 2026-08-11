import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import type { PlanContext } from '../planContext';
import {
  buildSwapState,
  cleanupCompletedSwaps,
  cleanupStaleSwaps,
  exportSwapState,
  type SwapState,
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
  type RestoreTiming,
} from './timing';
import { applyBudgetExemptRestorePass } from './exemptRestoreLane';
import { resolveHeadroomReserves, type HeadroomReserve } from '../admission';
import { reserveHeadroomForPendingRestores } from './support';
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
  RestoreBatchState,
  RestoreCooldownPreview,
  RestoreDeps,
  RestorePlanResult,
} from './types';

export type { RestoreDeps, RestorePlanResult } from './types';

export function applyRestorePlan(params: {
  planDevices: DevicePlanDevice[];
  context: PlanContext;
  state: PlanEngineState;
  sheddingActive: boolean;
  guardInShortfall?: boolean;
  deps: RestoreDeps;
}): RestorePlanResult {
  const { planDevices, context, state, sheddingActive, guardInShortfall = false, deps } = params;
  const deviceMap = new Map(planDevices.map((dev) => [dev.id, dev]));
  const swapState = buildSwapState(state);
  const headroomReserves = resolveCycleHeadroomReserves(planDevices, context, state);
  const timing = buildRestoreTiming(state, context.headroomRaw, deps.powerTracker);
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
  const ledger = buildCycleHeadroomLedger({ context, planDevices, state, deps, guardInShortfall });
  let restoredOneThisCycle = false;
  let restoreCooldownPreview: RestoreCooldownPreview | null = null;
  const batchState = buildRestoreBatchState({
    context,
    timing: effectiveTiming,
    availableHeadroom: ledger.summaryAvailableKw(),
  });

  if (guardInShortfall) {
    markRestoreCandidatesStayShedForShortfall({
      deviceMap,
      headroomKw: context.headroomRaw,
      setDevice: (id, updates) => setDevice(deviceMap, id, updates),
    });
  } else if (shouldPlanRestores(context.headroomRaw, sheddingActive, effectiveTiming)) {
    ({ restoredOneThisCycle } = applyFullRestorePass({
      deviceMap, swapState, state, effectiveTiming, ledger,
      restoredThisCycle, restoredOneThisCycle, batchState, deps, headroomReserves,
    }));
  } else if (shouldPlanBudgetExemptRestores({
    sheddingActive,
    softLimitSource: context.softLimitSource,
    capacityHeadroomKw: context.capacityHeadroomKw,
    // Raw timing on purpose: under daily source effectiveTiming clears the
    // startup-stabilization hold, but this lane runs while shedding is latched
    // — keep the conservative hold there.
    timing,
  })) {
    ({ restoredOneThisCycle } = applyBudgetExemptRestorePass({
      deviceMap,
      swapState,
      state,
      timing: effectiveTiming,
      ledger,
      restoredThisCycle,
      restoredOneThisCycle,
      headroomReserves,
      deps,
    }));
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
    ({ restoredOneThisCycle, restoreCooldownPreview } = applyRestorePlanInCooldown({
      deviceMap, swapState, state, context, effectiveTiming, deps,
      ledger, restoredOneThisCycle, restoredThisCycle, headroomReserves,
    }));
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
function buildCycleHeadroomLedger(params: {
  context: PlanContext;
  planDevices: DevicePlanDevice[];
  state: PlanEngineState;
  deps: RestoreDeps;
  guardInShortfall: boolean;
}): RestoreHeadroomLedger {
  const { context, planDevices, state, deps, guardInShortfall } = params;
  const reservedBindingHeadroom = guardInShortfall
    ? context.headroomRaw
    : reserveHeadroomForPendingRestores({
      rawHeadroom: context.headroomRaw,
      planDevices,
      lastDeviceRestoreMs: state.lastDeviceRestoreMs,
      measurementTs: deps.powerTracker.lastTimestamp ?? null,
      debugStructured: deps.debugStructured,
      deviceNameById: deps.deviceNameById,
    });
  const pendingReserveKw = Math.max(0, context.headroomRaw - reservedBindingHeadroom);
  return buildRestoreHeadroomLedger({
    capacityAvailableKw: context.capacityHeadroomKw - pendingReserveKw,
    budgetAvailableKw: context.budgetHeadroomKw === null ? null : context.budgetHeadroomKw - pendingReserveKw,
  });
}

// Startup reservations for this cycle: power a higher-priority device is holding back until it
// reaches its lowest active step. Resolved once per restore pass (the call also re-stamps the
// arming clock) and handed to the admission gates, which subtract it per candidate by priority.
function resolveCycleHeadroomReserves(
  planDevices: DevicePlanDevice[],
  context: PlanContext,
  state: PlanEngineState,
): HeadroomReserve[] {
  return resolveHeadroomReserves({
    devices: planDevices,
    planningTotalKw: context.planningTotalKw,
    state,
    nowTs: Date.now(),
  });
}

// The ordinary unrestricted restore pass (the shouldPlanRestores branch of
// applyRestorePlan), extracted to keep that function within the line ceiling.
function applyFullRestorePass(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  swapState: SwapState;
  state: PlanEngineState;
  effectiveTiming: RestoreTiming;
  ledger: RestoreHeadroomLedger;
  restoredThisCycle: Set<string>;
  restoredOneThisCycle: boolean;
  batchState: RestoreBatchState;
  deps: RestoreDeps;
  headroomReserves: readonly HeadroomReserve[];
}): { restoredOneThisCycle: boolean } {
  const {
    deviceMap, swapState, state, effectiveTiming, ledger,
    restoredThisCycle, batchState, deps, headroomReserves,
  } = params;
  let { restoredOneThisCycle } = params;
  const snapshot = Array.from(deviceMap.values());
  const restoreCandidates = getRestoreCandidates(snapshot);
  const onDevices = getOnDevices(snapshot, deps.getShedBehavior);
  const steppedSwapExecutor = buildSteppedSwapExecutor({
    deviceMap,
    onDevices,
    swapState,
    state,
    timing: effectiveTiming,
    restoredThisCycle,
    deps,
  });
  ({ restoredOneThisCycle } = applyRestoreCandidates({
    restoreCandidates,
    deviceMap,
    onDevices,
    swapState,
    state,
    timing: effectiveTiming,
    ledger,
    restoredThisCycle,
    restoredOneThisCycle,
    batchState,
    deps,
    steppedSwapExecutor,
    headroomReserves,
  }));
  return applyActiveSteppedRestoreCandidates({
    deviceMap,
    swapState,
    state,
    timing: effectiveTiming,
    ledger,
    restoredOneThisCycle,
    debugStructured: deps.debugStructured,
    steppedSwapExecutor,
    headroomReserves,
  });
}

// Handles the inRestoreCooldown branch of applyRestorePlan, extracted to keep that function's
// cognitive complexity within the allowed ceiling.
function applyRestorePlanInCooldown(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  swapState: SwapState;
  state: PlanEngineState;
  context: PlanContext;
  effectiveTiming: RestoreTiming;
  deps: RestoreDeps;
  ledger: RestoreHeadroomLedger;
  restoredOneThisCycle: boolean;
  restoredThisCycle: Set<string>;
  headroomReserves: readonly HeadroomReserve[];
}): { restoredOneThisCycle: boolean; restoreCooldownPreview: RestoreCooldownPreview | null } {
  const {
    deviceMap, swapState, state, context, effectiveTiming, deps, restoredThisCycle, ledger,
  } = params;
  const steppedSwapExecutor = buildSteppedSwapExecutor({
    deviceMap,
    onDevices: getOnDevices(Array.from(deviceMap.values()), deps.getShedBehavior),
    swapState,
    state,
    timing: effectiveTiming,
    restoredThisCycle,
    deps,
  });
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
      if (holdPendingSwapTargetUntilSourcesAreOff({ swapState, targetDevice: dev, deviceMap })) continue;
      setDevice(deviceMap, dev.id, { reason });
    }
    return {
      restoredOneThisCycle: params.restoredOneThisCycle,
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
      restoredOneThisCycle: params.restoredOneThisCycle,
      restoreCooldownPreview: null,
    };
  }

  // Preview the ordinary direct-admission path with the global cooldown lifted. The preview
  // writes hold reasons, never restore intents or swaps. It uses a private ledger and batch
  // state so the hypothetical cohort cannot consume power from later planning stages.
  const previewTiming = { ...effectiveTiming, inRestoreCooldown: false as const };
  const previewLedger = buildRestoreHeadroomLedger(ledger.axes());
  const previewBatchState = buildRestoreBatchState({
    context,
    timing: previewTiming,
    availableHeadroom: previewLedger.summaryAvailableKw(),
  });
  const admissionMode = { kind: 'cooldown_preview' as const, holdReason };
  const snapshot = Array.from(deviceMap.values());
  let previewAdmitted = false;
  ({ restoredOneThisCycle: previewAdmitted } = applyRestoreCandidates({
    restoreCandidates: getRestoreCandidates(snapshot),
    deviceMap,
    onDevices: getOnDevices(snapshot, deps.getShedBehavior),
    swapState,
    state,
    timing: previewTiming,
    ledger: previewLedger,
    restoredThisCycle,
    restoredOneThisCycle: previewAdmitted,
    batchState: previewBatchState,
    deps,
    steppedSwapExecutor,
    headroomReserves: params.headroomReserves,
    admissionMode,
  }));
  ({ restoredOneThisCycle: previewAdmitted } = applyActiveSteppedRestoreCandidates({
    deviceMap,
    swapState,
    state,
    timing: previewTiming,
    ledger: previewLedger,
    restoredOneThisCycle: previewAdmitted,
    debugStructured: deps.debugStructured,
    steppedSwapExecutor,
    headroomReserves: params.headroomReserves,
    admissionMode,
  }));
  return {
    restoredOneThisCycle: params.restoredOneThisCycle,
    restoreCooldownPreview: {
      holdReason,
      selectedOne: previewAdmitted,
      appliesToAllCandidates: false,
      ...previewLedger.axes(),
    },
  };
}
