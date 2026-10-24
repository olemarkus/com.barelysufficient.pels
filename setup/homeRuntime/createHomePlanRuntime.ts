import { createPlanEngineComposition, type CreatePlanEngineOptions } from '../appInit/createPlanEngine';
import { createPlanService } from '../appInit/createPlanService';
import type { AppContext } from '../../lib/app/appContext';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanService } from '../../lib/plan/planService';
import { createLastControlledStore, importLegacyLastControlled } from '../../lib/plan/lastControlledStore';
import type { HomeScope } from './homeScope';

export type HomePlanRuntime = {
  planEngine: PlanEngine;
  planService: PlanService;
  lifecycleFallbackPort: NonNullable<AppContext['lifecycleFallback']>;
};

/**
 * One home's plan runtime: its engine, the control state that engine resumes
 * from, and the service that drives it.
 *
 * The main home and every meter area assembled this identically and separately
 * — engine, load the persisted last-controlled map, open the startup restore
 * window, then the service over that engine. Identically down to the arguments:
 * the last-controlled store answers per home id (importing that home's legacy
 * settings key first), and both opened the restore window at `Date.now()`.
 * The only reason there were two was that
 * Main's assembly is spread across boot steps while an area's happens in one
 * call.
 *
 * Everything a home differs by arrives through `scope` and `options` — which
 * devices it plans, what it may actuate, which guard bounds it — so this
 * function never asks which home it is building for. The id comes from the
 * scope too: a home's identity is part of the scope it hands over, not a
 * second argument a caller could disagree with it about.
 */
export const createHomePlanRuntime = (
  ctx: AppContext,
  scope: HomeScope,
  options: CreatePlanEngineOptions,
): HomePlanRuntime => {
  const { planEngine, lifecycleFallbackPort } = createPlanEngineComposition(ctx, scope, options);
  const lastControlled = createLastControlledStore(ctx.getUserdataDatabase());
  importLegacyLastControlled(ctx.homey.settings, lastControlled, scope.homeId);
  planEngine.state.actuation.loadLastControlled(lastControlled.read(scope.homeId));
  // Hold restores until this home's meter proves live; the first fresh sample
  // clears the window through the pipeline.
  planEngine.beginStartupRestoreStabilization(Date.now());
  return { planEngine, planService: createPlanService(ctx, scope, planEngine), lifecycleFallbackPort };
};
