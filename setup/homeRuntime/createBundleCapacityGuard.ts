import type { AppContext } from '../../lib/app/appContext';
import { getLogger } from '../../lib/logging/logger';
import { computeShortfallThreshold } from '../../lib/plan/planBudget';
import { resolveLastTotalPowerKw } from '../../lib/power/lastTotalPower';
import type { PlanService } from '../../lib/plan/planService';
import CapacityGuard from '../../lib/power/capacityGuard';
import type { CapacityScalarSettings } from '../../lib/power/capacitySettingsStore';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { HomeId } from '../../lib/utils/settingsKeys';
import { createCapacityShortfallAlertDispatch } from '../capacityShortfallAlertDispatch';
import { createCapacityShortfallSideEffectGate } from '../capacityShortfallSideEffectGate';

const SHORTFALL_SIDE_EFFECT_RETRY_MS = 1_000;

/**
 * Wires one sub-home's immediate shortfall state transition and its user Flow
 * alerts. Lifecycle/source authority is checked at both final setup-owned
 * side-effect seams.
 */
export function createBundleCapacityGuard(params: {
  ctx: AppContext;
  homeId: HomeId;
  scalars: CapacityScalarSettings;
  planService: PlanService;
  getHomeDisplayName: () => string;
  getPowerTracker: () => PowerTrackerState;
  isTornDown: () => boolean;
  isMembershipReady: () => boolean;
  isMeterSourceAuthorized: () => boolean;
  isMeterSourceEpochDiscarded: () => boolean;
  isPreparedReconcileActive: () => boolean;
  shortfallRetryTimerKey: string;
  shortfallAlertImmediateTimerKey: string;
  shortfallAlertSustainedTimerKey: string;
}): {
  guard: CapacityGuard;
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
  holdDeferredShortfallSideEffect: () => void;
} {
  const {
    ctx, homeId, scalars, planService, getHomeDisplayName, getPowerTracker,
    isTornDown, isMembershipReady,
    isMeterSourceAuthorized, isMeterSourceEpochDiscarded,
    isPreparedReconcileActive, shortfallRetryTimerKey,
    shortfallAlertImmediateTimerKey, shortfallAlertSustainedTimerKey,
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
  const shortfallAlertDispatch = createCapacityShortfallAlertDispatch({
    homeId,
    timers: ctx.timers,
    immediateTimerKey: shortfallAlertImmediateTimerKey,
    sustainedTimerKey: shortfallAlertSustainedTimerKey,
    isDiscarded,
    isTemporarilyFenced,
    isConditionActive: () => guard.isShortfallAlertConditionActive(
      resolveLastTotalPowerKw(getPowerTracker()),
      computeShortfallThreshold({ capacitySettings: scalars, powerTracker: getPowerTracker() }),
    ),
    getHomeDisplayName,
    flow: ctx.homey.flow,
  });
  const guard = new CapacityGuard({
    homeId,
    onShortfall: shortfallSideEffectGate.onShortfall,
    onShortfallCleared: async () => {
      shortfallAlertDispatch.onIncidentCleared();
      await shortfallSideEffectGate.onShortfallCleared();
    },
    onShortfallAlertCandidate: shortfallAlertDispatch.onCandidate,
    onShortfallAlertConditionCleared: shortfallAlertDispatch.onConditionCleared,
    // See `createMainCapacityGuard`: setup classifies the boot-window
    // `undefined`, so the guard is handed a definite logger.
    structuredLog: ctx.getStructuredLogger('capacity') ?? getLogger('power/capacity-guard'),
  });
  return {
    guard,
    flushDeferredShortfallSideEffect: shortfallSideEffectGate.flushAfterPreparedApply,
    holdDeferredShortfallSideEffect: shortfallSideEffectGate.holdDeferredUntilPreparedApply,
  };
}
