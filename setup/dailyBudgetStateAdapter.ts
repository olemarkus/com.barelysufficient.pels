import type Homey from 'homey';
import type { DailyBudgetStateStore } from '../lib/dailyBudget/dailyBudgetStateStore';
import type { DailyBudgetState } from '../lib/dailyBudget/dailyBudgetTypes';
import { DAILY_BUDGET_STATE } from '../lib/utils/settingsKeys';

/**
 * Builds the {@link DailyBudgetStateStore}: the sole owner of the
 * `homey.settings` read/write for the persisted daily-budget state blob. The
 * service receives this typed store and never touches `homey.settings` itself.
 */
export const createDailyBudgetStateStore = (
  homey: Homey.App['homey'],
): DailyBudgetStateStore => ({
  read(): unknown {
    return homey.settings.get(DAILY_BUDGET_STATE);
  },
  write(state: DailyBudgetState): void {
    homey.settings.set(DAILY_BUDGET_STATE, state);
  },
});
