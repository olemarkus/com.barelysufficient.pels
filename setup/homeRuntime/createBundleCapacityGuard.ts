import type { AppContext } from '../../lib/app/appContext';
import type { PlanEngine } from '../../lib/plan/planEngine';
import { buildPlanCapacityStateSummary } from '../../lib/plan/planLogging';
import type { PlanService } from '../../lib/plan/planService';
import CapacityGuard from '../../lib/power/capacityGuard';
import type { CapacityScalarSettings } from '../../lib/power/capacitySettingsStore';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { HomeId } from '../../lib/utils/settingsKeys';
import { createCapacityShortfallAlertHold } from '../capacityShortfallAlertHold';
import { createCapacityShortfallSideEffectGate } from '../capacityShortfallSideEffectGate';

const SHORTFALL_SIDE_EFFECT_RETRY_MS = 1_000;

/**
 * Wires one sub-home's immediate shortfall state transition and independently
 * held user Flow alert. Lifecycle/source authority is checked at both final
 * setup-owned side-effect seams.
 */
export function createBundleCapacityGuard(params: {
  ctx: AppContext;
  homeId: HomeId;
  scalars: CapacityScalarSettings;
  planEngine: PlanEngine;
  planService: PlanService;
  getHomeDisplayName: () => string;
  isTornDown: () => boolean;
  isMembershipReady: () => boolean;
  isMeterSourceAuthorized: () => boolean;
  isMeterSourceEpochDiscarded: () => boolean;
  isPreparedReconcileActive: () => boolean;
  shortfallRetryTimerKey: string;
  shortfallAlertTimerKey: string;
}): {
  guard: CapacityGuard;
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
  holdDeferredShortfallSideEffect: () => void;
} {
  const {
    ctx, homeId, scalars, planEngine, planService, getHomeDisplayName, isTornDown, isMembershipReady,
    isMeterSourceAuthorized, isMeterSourceEpochDiscarded,
    isPreparedReconcileActive, shortfallRetryTimerKey, shortfallAlertTimerKey,
  } = params;
  const isDiscarded = (): boolean => isTornDown() || isMeterSourceEpochDiscarded();
  const isTemporarilyFenced = (): boolean => (
    isPreparedReconcileActive() || !isMembershipReady() || !isMeterSourceAuthorized()
  );
  const scheduleShortfallRetry = (): void => {
    if (isTornDown() || ctx.timers.has(shortfallRetryTimerKey)) return;
    ctx.timers.registerTimeout(shortfallRetryTimerKey, setTimeout(() => {
      ctx.timers.clear(shortfallRetryTimerKey);
      void shortfallSideEffectGate.flush().catch((error: unknown) => {
        ctx.getStructuredLogger('homes')?.warn({
          event: 'home_shortfall_side_effect_retry_failed',
          homeId,
          err: normalizeError(error),
        });
      });
    }, SHORTFALL_SIDE_EFFECT_RETRY_MS));
  };
  const shortfallSideEffectGate = createCapacityShortfallSideEffectGate({
    isDiscarded,
    isTemporarilyFenced,
    shouldHoldDeferredForPreparedApply: isPreparedReconcileActive,
    scheduleRetry: scheduleShortfallRetry,
    applyShortfall: (deficitKw) => planService.handleShortfall(deficitKw),
    applyClear: () => planService.handleShortfallCleared(),
  });
  const shortfallAlertHold = createCapacityShortfallAlertHold({
    homeId,
    timers: ctx.timers,
    timerKey: shortfallAlertTimerKey,
    isDiscarded,
    isTemporarilyFenced,
    isConditionActive: () => guard.isShortfallAlertConditionActive(),
    getHomeDisplayName,
    flow: ctx.homey.flow,
  });
  const guard = new CapacityGuard({
    homeId,
    limitKw: scalars.limitKw,
    softMarginKw: scalars.marginKw,
    onShortfall: shortfallSideEffectGate.onShortfall,
    onShortfallCleared: async () => {
      shortfallAlertHold.onIncidentCleared();
      await shortfallSideEffectGate.onShortfallCleared();
    },
    onShortfallAlertCandidate: shortfallAlertHold.onCandidate,
    onShortfallAlertConditionCleared: shortfallAlertHold.onConditionCleared,
    structuredLog: ctx.getStructuredLogger('capacity'),
    capacityStateSummaryProvider: () => buildPlanCapacityStateSummary(
      planService.getLatestPlanSnapshot(),
      {
        summarySource: 'plan_snapshot',
        summarySourceAtMs: planService.getLatestPlanSnapshotUpdatedAtMs() ?? null,
      },
    ),
  });
  guard.setSoftLimitProvider(() => planEngine.computeDynamicSoftLimit());
  guard.setShortfallThresholdProvider(() => planService.computeShortfallThreshold());
  return {
    guard,
    flushDeferredShortfallSideEffect: shortfallSideEffectGate.flushAfterPreparedApply,
    holdDeferredShortfallSideEffect: shortfallSideEffectGate.holdDeferredUntilPreparedApply,
  };
}
