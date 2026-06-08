import type { AppContext } from '../../lib/app/appContext';
import type { BuildPriceHorizon } from '../../lib/objectives/deferredObjectives';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';

// Single source of truth for the deferred-objective allocation-horizon price
// source. Resolves the per-hour price grid directly from the price layer (a
// legacy V1 payload is migrated to V2 on read, matching `createPlanService` /
// `deferredRecorders`) so the leafward objectives subsystem never imports
// `lib/price`. Shared by the plan engine, the lifecycle emitter, and the
// create-task preview wiring.
export const createObjectivePriceHorizonBuilder = (ctx: AppContext): BuildPriceHorizon => (
  (nowMs, deadlineAtMs) => buildPriceHorizonFromCombined(
    ctx.combinedPricesReader.readStore(ctx.getNow(), ctx.getTimeZone()),
    nowMs,
    deadlineAtMs,
  )
);
