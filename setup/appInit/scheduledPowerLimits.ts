import type { AppContext } from '../../lib/app/appContext';
import { planningCeilingSchedule, resolveScheduledPowerLimits } from '../../lib/power/heldCapacityLimit';

export const readScheduledPowerLimits = (ctx: AppContext, nowMs: number) => resolveScheduledPowerLimits(
  ctx.getCapacityScalars(), (atMs) => ctx.getCurrentMonthCapacityPeak(atMs), ctx.getTimeZone(), nowMs,
);

export const readPlanningCeilingSchedule = (ctx: AppContext, nowMs: number) => (
  planningCeilingSchedule(readScheduledPowerLimits(ctx, nowMs))
);
