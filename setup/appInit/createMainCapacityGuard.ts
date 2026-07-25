import CapacityGuard from '../../lib/power/capacityGuard';
import { buildPlanCapacityStateSummary } from '../../lib/plan/planLogging';
import type { AppContext } from '../../lib/app/appContext';
import { normalizeError } from '../../lib/utils/errorUtils';
import {
  createCapacityShortfallSideEffectGate,
  type CapacityShortfallSideEffectGate,
} from '../capacityShortfallSideEffectGate';

const MAIN_SHORTFALL_SIDE_EFFECT_RETRY_TIMER = 'mainShortfallSideEffectRetry';
const MAIN_SHORTFALL_SIDE_EFFECT_RETRY_MS = 1_000;

export const createMainCapacityGuard = (params: {
  ctx: AppContext;
  isDiscarded: () => boolean;
  isTemporarilyFenced: () => boolean;
  isPreparedReconcileActive: () => boolean;
}): {
  guard: CapacityGuard;
  shortfallSideEffectGate: CapacityShortfallSideEffectGate;
} => {
  const { ctx } = params;
  const scheduleShortfallRetry = (): void => {
    if (params.isDiscarded() || ctx.timers.has(MAIN_SHORTFALL_SIDE_EFFECT_RETRY_TIMER)) return;
    ctx.timers.registerTimeout(MAIN_SHORTFALL_SIDE_EFFECT_RETRY_TIMER, setTimeout(() => {
      ctx.timers.clear(MAIN_SHORTFALL_SIDE_EFFECT_RETRY_TIMER);
      void shortfallSideEffectGate.flush().catch((error: unknown) => {
        ctx.getStructuredLogger('capacity')?.warn({
          event: 'main_shortfall_side_effect_retry_failed',
          err: normalizeError(error),
        });
      });
    }, MAIN_SHORTFALL_SIDE_EFFECT_RETRY_MS));
  };
  const shortfallSideEffectGate = createCapacityShortfallSideEffectGate({
    isDiscarded: params.isDiscarded,
    isTemporarilyFenced: params.isTemporarilyFenced,
    shouldHoldDeferredForPreparedApply: params.isPreparedReconcileActive,
    scheduleRetry: scheduleShortfallRetry,
    applyShortfall: async (deficitKw) => ctx.planService?.handleShortfall(deficitKw),
    applyClear: async () => ctx.planService?.handleShortfallCleared(),
  });
  const guard = new CapacityGuard({
    limitKw: ctx.capacitySettings.limitKw,
    softMarginKw: ctx.capacitySettings.marginKw,
    onShortfall: shortfallSideEffectGate.onShortfall,
    onShortfallCleared: shortfallSideEffectGate.onShortfallCleared,
    structuredLog: ctx.getStructuredLogger('capacity'),
    capacityStateSummaryProvider: () => buildPlanCapacityStateSummary(
      ctx.planService?.getLatestPlanSnapshot(),
      {
        summarySource: 'plan_snapshot',
        summarySourceAtMs: ctx.planService?.getLatestPlanSnapshotUpdatedAtMs() ?? null,
      },
    ),
  });
  return { guard, shortfallSideEffectGate };
};
