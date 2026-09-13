/**
 * One home's capacity guard: the immediate shortfall transition it drives on
 * that home's own plan service, and the two hard-cap Flow alert lanes it feeds.
 *
 * Main and every meter area assembled this identically and separately, and the
 * differences were all naming. Main read its scalars, its tracker and its
 * display name straight off `AppContext` while an area took three getters; Main
 * spelled its three timer keys as module constants while an area derived them
 * from its own `home:<id>:` prefix; Main composed its two authority predicates
 * at the call site while an area composed the same two from four primitives in
 * here. None of that is a difference between the homes — it is the difference
 * between the one home whose capacity state is ambient on the context and the
 * ones whose state is not.
 *
 * So everything a home differs by arrives through `scope`, `authority` and
 * `timerKey`, and this function never asks which home it is building for. The
 * id and the display name come from the scope for the same reason
 * `createHomePlanRuntime` takes them from there: a home's identity is part of
 * the scope it hands over, not a second argument a caller could disagree with
 * it about.
 */
import type { AppContext } from '../../lib/app/appContext';
import { getLogger } from '../../lib/logging/logger';
import { computeShortfallThreshold } from '../../lib/plan/planBudget';
import type { PlanService } from '../../lib/plan/planService';
import CapacityGuard from '../../lib/power/capacityGuard';
import { resolveLastTotalPowerKw } from '../../lib/power/lastTotalPower';
import { normalizeError } from '../../lib/utils/errorUtils';
import { createCapacityShortfallAlertDispatch } from '../capacityShortfallAlertDispatch';
import {
  createCapacityShortfallSideEffectGate,
  type CapacityShortfallSideEffectGate,
} from '../capacityShortfallSideEffectGate';
import type { HomeScope } from './homeScope';

const SHORTFALL_SIDE_EFFECT_RETRY_MS = 1_000;

export type HomeCapacityGuardRuntime = {
  guard: CapacityGuard;
  shortfallSideEffectGate: CapacityShortfallSideEffectGate;
};

/**
 * `timerKey` names this home's three timers in the shared registry, the same
 * per-home namer `HomeTrackerPersistence` and the bundle's other seams take:
 * identity for Main (its namespace is the bare name, as `homeScopedSettingsKey`
 * is identity for its settings keys), `home:<id>:<suffix>` for a meter area.
 * The keys are derived here rather than passed because this is the wiring that
 * arms them, and teardown clears them through the same namer.
 *
 * `getPlanService` is lazy on purpose: its only uses are the two deferred
 * shortfall callbacks, which fire when a hard-cap incident happens, long after
 * boot. Binding it eagerly would force the plan engine to be constructed before
 * the guard, and the guard is the engine's own capacity input.
 *
 * The three predicates say whether this home's capacity side effects may act
 * right now, and when they may not, which kind of "not" it is. They are three
 * arguments and not one object because no home holds such an object: both
 * callers would assemble a literal for this one call, which is the bag the
 * parameter rule bans however it is named.
 *
 * - `isDiscarded` is permanent for this runtime (torn down, or the meter
 *   source's epoch invalidated). A transition observed behind it is dropped,
 *   never retained, so there is nothing left for a retry to carry.
 * - `isAuthorityClosed` is this home's own standing, and it can reopen:
 *   membership not yet joined, the meter source not yet authorized, Main
 *   fenced home-wide. A transition observed behind it is held and retried.
 * - `isPreparedReconcileActive` is one prepared plan owning the actuator for
 *   the length of its apply. It also holds, and it additionally decides which
 *   flush may CONSUME the hold — a generic retry must not spend a transition
 *   that belongs to the plan now applying.
 *
 * The fence the gate and the alert lanes read is the union of the last two,
 * composed here rather than asked for: a caller spelling the union itself
 * could leave the prepared fence out of it, and the hold would then be offered
 * to a generic flush that is required to refuse it. Both homes used to spell
 * that union, identically, at their own call sites.
 */
export const createHomeCapacityGuard = (
  ctx: AppContext,
  scope: HomeScope,
  timerKey: (suffix: string) => string,
  getPlanService: () => PlanService,
  isDiscarded: () => boolean,
  isAuthorityClosed: () => boolean,
  isPreparedReconcileActive: () => boolean,
): HomeCapacityGuardRuntime => {
  const isTemporarilyFenced = (): boolean => isPreparedReconcileActive() || isAuthorityClosed();
  const retryTimerKey = timerKey('shortfallSideEffectRetry');
  const scheduleShortfallRetry = (): void => {
    if (isDiscarded() || ctx.timers.has(retryTimerKey)) return;
    ctx.timers.registerTimeout(retryTimerKey, setTimeout(() => {
      ctx.timers.clear(retryTimerKey);
      void shortfallSideEffectGate.flush().catch((error: unknown) => {
        ctx.getStructuredLogger('capacity')?.warn({
          event: 'home_shortfall_side_effect_retry_failed',
          homeId: scope.homeId,
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
    applyShortfall: (deficitKw) => getPlanService().handleShortfall(deficitKw),
    applyClear: () => getPlanService().handleShortfallCleared(),
  });
  const shortfallAlertDispatch = createCapacityShortfallAlertDispatch({
    homeId: scope.homeId,
    timers: ctx.timers,
    immediateTimerKey: timerKey('shortfallAlertImmediate'),
    sustainedTimerKey: timerKey('shortfallAlertSustained'),
    isDiscarded,
    isTemporarilyFenced,
    // Read through the scope on every call, never snapshotted: a meter area's
    // `reloadCapacityScalars` REPLACES its scalar object on a settings change,
    // so a construction-time copy would leave this predicate re-checking the
    // old cap while planning had already moved to the new one — suppressing a
    // real alert after a decrease, holding an obsolete one after an increase.
    isConditionActive: () => guard.isShortfallAlertConditionActive(
      resolveLastTotalPowerKw(scope.getPowerTracker()),
      computeShortfallThreshold({
        capacitySettings: scope.getCapacitySettings(),
        powerTracker: scope.getPowerTracker(),
      }),
    ),
    getHomeDisplayName: scope.getHomeDisplayName,
    flow: ctx.homey.flow,
  });
  const guard = new CapacityGuard({
    homeId: scope.homeId,
    onShortfall: shortfallSideEffectGate.onShortfall,
    onShortfallCleared: async () => {
      shortfallAlertDispatch.onIncidentCleared();
      await shortfallSideEffectGate.onShortfallCleared();
    },
    onShortfallAlertCandidate: shortfallAlertDispatch.onCandidate,
    onShortfallAlertConditionCleared: shortfallAlertDispatch.onConditionCleared,
    // Resolved here, not defaulted inside the guard: `getStructuredLogger`
    // answers `undefined` only in the boot window before structured logging is
    // wired, and classifying that is setup's job. The guard is handed a
    // definite logger and never branches on whether logging came up.
    structuredLog: ctx.getStructuredLogger('capacity') ?? getLogger('power/capacity-guard'),
  });
  return { guard, shortfallSideEffectGate };
};
