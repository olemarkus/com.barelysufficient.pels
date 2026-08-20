import type { AppContext } from '../../lib/app/appContext';
import type { PlanService } from '../../lib/plan/planService';
import type { FlowHomeyLike } from '../../lib/utils/types';

/**
 * AppContext dependency-presence guards. Each `require*` asserts that a service
 * the wiring order is supposed to have already constructed is actually present,
 * surfacing the canonical "must be initialized" error at the wiring seam rather
 * than a downstream `undefined` dereference. Shared by the service factories and
 * the flow-card registrar.
 */

export function requireDeviceManager(ctx: AppContext) {
  if (!ctx.deviceManager) {
    throw new Error('DeviceTransport must be initialized before plan engine setup.');
  }
  return ctx.deviceManager;
}

export function requirePlanEngine(ctx: AppContext) {
  if (!ctx.planEngine) {
    throw new Error('PlanEngine must be initialized before plan service setup.');
  }
  return ctx.planEngine;
}

/**
 * The ONE PlanService presence guard. `AppContext.planService` is optional only
 * because of an initialisation cycle — `createPlanService(ctx, …)` needs the
 * context that holds the field — so every consumer that runs after
 * `AppServiceWiring.initPlanService` reads a value that is always there. Three
 * separate files had each redeclared this guard with its own message; they now
 * all call this one, which is why the message names no particular seam.
 *
 * Use it wherever a throw is the honest answer: a caller that runs after
 * `initPlanService` and can surface an error. Where a caller is a fire-and-forget
 * `void` on a lane that is live earlier than that, use {@link resolvePlanService}
 * — a synchronous throw out of `void fn()` cannot be caught by the `.catch` the
 * call site appears to have.
 */
export function requirePlanService(ctx: AppContext): PlanService {
  if (!ctx.planService) {
    throw new Error('PlanService must be initialized before use.');
  }
  return ctx.planService;
}

/**
 * The plan service as an explicit semantic result, for lanes that can genuinely
 * run before `initPlanService`.
 *
 * The observed-state lane no longer needs this — its plan-dependent listeners
 * were moved into their own startup step (`subscribePlanObservedState`) after
 * `initPlanService`. The target-power reachability lane still does: its snapshot
 * mutation hook is bound with the transport during `initDeviceManager`, and it
 * requests the owning home's rebuild through a fire-and-forget `void` call. A
 * `requirePlanService` there throws SYNCHRONOUSLY, so it escapes past the
 * `.catch` chained to the call and out of the `void`, with nothing able to
 * handle it. Callers branch on this union and answer `not_wired` with a
 * completed no-op instead.
 */
export type PlanServiceResolution =
  | { state: 'ready'; planService: PlanService }
  | { state: 'not_wired' };

export function resolvePlanService(ctx: AppContext): PlanServiceResolution {
  const planService = ctx.planService;
  if (!planService) return { state: 'not_wired' };
  return { state: 'ready', planService };
}

export function requireDailyBudgetService(ctx: AppContext) {
  if (!ctx.dailyBudgetService) {
    throw new Error('DailyBudgetService must be initialized before flow card registration.');
  }
  return ctx.dailyBudgetService;
}

export function requireFlowHomey(ctx: AppContext): FlowHomeyLike {
  const { homey } = ctx;
  if (
    typeof homey.flow?.getTriggerCard !== 'function'
    || typeof homey.flow?.getConditionCard !== 'function'
    || typeof homey.flow?.getActionCard !== 'function'
    || typeof homey.settings?.get !== 'function'
    || typeof homey.settings?.set !== 'function'
  ) {
    throw new Error('Flow card registration requires Homey flow and settings APIs.');
  }
  return homey as unknown as FlowHomeyLike;
}
