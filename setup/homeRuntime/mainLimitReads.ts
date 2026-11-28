import type { AppContext } from '../../lib/app/appContext';
import { resolveHeldPowerLimits, type HeldPowerLimitSettings } from '../../lib/power/heldCapacityLimit';
import type { MainFuse } from '../../packages/contracts/src/capacitySettings';
import type { DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';

/**
 * Main's three limit reads, shared by its planner scope (`homeScope.ts`) and its
 * meter-silence monitor (`createHomePowerPipeline.ts`), so both answer "does a
 * limit rely on the meter?" from the same sources. Live snapshot reads, not
 * re-reads through the settings store: the snapshot is the in-memory truth kept
 * current by the settings handler. Main's month peak is the one its readout
 * shows (`getCurrentMonthCapacityPeak`): its tracker against the peak its
 * selected meter reports.
 */
export const readMainHeldPowerLimits = (
  ctx: Pick<AppContext, 'getCapacityScalars' | 'getCurrentMonthCapacityPeak'>,
): HeldPowerLimitSettings => resolveHeldPowerLimits(ctx.getCapacityScalars('live'), ctx.getCurrentMonthCapacityPeak());

export const readMainFuse = (ctx: Pick<AppContext, 'capacitySettingsStore'>): MainFuse => (
  ctx.capacitySettingsStore.mainFuse()
);

/** `null` while the budget service is not constructed or has no snapshot yet. */
export const readMainDailyBudgetSnapshot = (
  ctx: Pick<AppContext, 'dailyBudgetService'>,
): DailyBudgetUiPayload | null => ctx.dailyBudgetService?.getSnapshot() ?? null;
