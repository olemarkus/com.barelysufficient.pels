import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanEngineState } from '../planState';
import type { PlanContext } from '../planContext';

import { isCapacityBreached } from '../planRemainingSheddableLoad';
import { updateGuardState, resolvePlanningTotalPower } from '../admission';
import {
  type PlanSheddingResult,
  type SheddingDeps,
  type SheddingPlan,
} from './types';
import {
  emitOvershootEscalationBlocked,
  resolveSameMeasurementSheddingDecision,
  buildOvershootStats,
} from './overshoot';
import { resolveShedReason, selectShedDevices } from './selection';
import { buildSheddingCandidates, summarizeSheddingCandidates } from './candidates';

export async function buildSheddingPlan(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable = context.headroom < 0,
): Promise<SheddingPlan> {
  const planningTotal = resolvePlanningTotalPower(context.total, context.powerKnown);
  const {
    shedSet,
    shedReasons,
    updates,
    overshootStats,
  } = planShedding(context, state, deps, overshootActionable);
  const hourlyBudgetExhausted = state.hourlyBudgetExhausted === true;
  const sheddingActionable = overshootActionable || hourlyBudgetExhausted;
  const sheddingLimitSource = hourlyBudgetExhausted ? 'daily' : context.softLimitSource;
  const wasSheddingActive = deps.capacityGuard?.isSheddingActive() ?? false;
  const guardResult = await updateGuardState({
    headroom: context.headroom,
    powerKnown: context.powerKnown,
    overshootActionable: sheddingActionable,
    capacitySoftLimit: context.capacitySoftLimit,
    total: planningTotal,
    devices: context.devices,
    shedSet,
    softLimitSource: sheddingLimitSource,
    getShedBehavior: deps.getShedBehavior,
    capacityGuard: deps.capacityGuard,
  });
  const guardInShortfall = deps.capacityGuard?.isInShortfall() ?? false;
  const recoveredFromShedding = wasSheddingActive && !guardResult.sheddingActive;
  const mergedUpdates = recoveredFromShedding
    ? { ...updates, lastRecoveryMs: Date.now() }
    : updates;
  return {
    shedSet,
    shedReasons,
    sheddingActive: guardResult.sheddingActive,
    guardInShortfall,
    updates: mergedUpdates,
    overshootStats,
  };
}

function shouldPlanShedding(headroom: number): boolean {
  return headroom < 0;
}

function emptySheddingResult(
  updates: PlanSheddingResult['updates'] = {},
  overshootStats: PlanSheddingResult['overshootStats'] = null,
): PlanSheddingResult {
  return {
    shedSet: new Set<string>(),
    shedReasons: new Map<string, DeviceReason>(),
    updates,
    overshootStats,
  };
}

function planShedding(
  context: PlanContext,
  state: PlanEngineState,
  deps: SheddingDeps,
  overshootActionable: boolean,
): PlanSheddingResult {
  const hourlyBudgetExhausted = state.hourlyBudgetExhausted === true;
  if (!shouldAttemptShedding({ hourlyBudgetExhausted, overshootActionable, headroom: context.headroom })) {
    return emptySheddingResult();
  }

  const nowTs = Date.now();
  const measurementTs = deps.powerTracker.lastTimestamp ?? null;
  const planningTotal = resolvePlanningTotalPower(context.total, context.powerKnown);
  const measurementDecision = resolveSameMeasurementSheddingDecision({
    state,
    measurementTs,
    nowTs,
    allowEscalation: isCapacityBreached(planningTotal, context.capacitySoftLimit),
  });

  const needed = Math.max(0, -context.headroom);
  const candidateNeeded = hourlyBudgetExhausted ? Number.POSITIVE_INFINITY : needed;
  const candidateLimitSource = hourlyBudgetExhausted ? 'daily' : context.softLimitSource;
  if (shouldSkipSameMeasurement({ hourlyBudgetExhausted, skip: measurementDecision.skip })) {
    const summary = summarizeSheddingCandidates({
      devices: context.devices,
      needed: candidateNeeded,
      limitSource: candidateLimitSource,
      total: planningTotal,
      capacitySoftLimit: context.capacitySoftLimit,
      state,
      deps,
    });
    deps.debugStructured?.({ event: 'plan_shed_skipped_awaiting_measurement' });
    return emptySheddingResult({}, buildOvershootStats({
      needed,
      eligibleCandidateCount: summary.eligibleCandidateCount,
      blockedCandidateCount: summary.blockedCandidateCount,
      reducibleControlledKw: summary.reducibleControlledKw,
      blockedReducibleControlledKw: summary.blockedReducibleControlledKw,
    }));
  }
  if (measurementDecision.escalatedSameSample) {
    deps.debugStructured?.({ event: 'plan_shed_escalating_unchanged_measurement' });
  }
  const candidateSummary = buildSheddingCandidates({
    devices: context.devices,
    needed: candidateNeeded,
    limitSource: candidateLimitSource,
    total: planningTotal,
    capacitySoftLimit: context.capacitySoftLimit,
    state,
    deps,
  });
  const { candidates } = candidateSummary;
  const overshootStats = buildOvershootStats({
    needed,
    eligibleCandidateCount: candidates.length,
    blockedCandidateCount: candidateSummary.blockedCandidateCount,
    reducibleControlledKw: candidateSummary.reducibleControlledKw,
    blockedReducibleControlledKw: candidateSummary.blockedReducibleControlledKw,
  });
  const result = selectShedDevices({
    candidates,
    needed,
    reason: resolveShedReason(hourlyBudgetExhausted ? 'daily' : context.softLimitSource),
    debugStructured: deps.debugStructured,
    shedAllCandidates: hourlyBudgetExhausted,
  });

  if (result.shedSet.size === 0) {
    if (measurementDecision.escalatedSameSample) {
      const controllableDeviceCount = context.devices
        .filter((device) => device.controllable !== false)
        .length;
      if (controllableDeviceCount > 0) {
        emitOvershootEscalationBlocked({
          structuredLog: deps.structuredLog,
          capacityGuard: deps.capacityGuard,
          neededKw: needed,
          remainingCandidates: candidates.length,
          measurementTs,
          nowTs,
        });
      }
      return emptySheddingResult({
        lastOvershootEscalationMs: nowTs,
        lastOvershootMitigationMs: nowTs,
      }, overshootStats);
    }
    return emptySheddingResult({}, overshootStats);
  }
  const updates = {
    lastInstabilityMs: nowTs,
    ...(measurementTs !== null ? { lastShedPlanMeasurementTs: measurementTs } : {}),
    lastOvershootMitigationMs: nowTs,
    ...(measurementDecision.escalatedSameSample ? { lastOvershootEscalationMs: nowTs } : {}),
  };
  return {
    ...result,
    updates,
    overshootStats,
  };
}

function shouldAttemptShedding(params: {
  hourlyBudgetExhausted: boolean;
  overshootActionable: boolean;
  headroom: number;
}): boolean {
  return params.hourlyBudgetExhausted
    || (params.overshootActionable && shouldPlanShedding(params.headroom));
}

function shouldSkipSameMeasurement(params: { hourlyBudgetExhausted: boolean; skip: boolean }): boolean {
  return !params.hourlyBudgetExhausted && params.skip;
}
