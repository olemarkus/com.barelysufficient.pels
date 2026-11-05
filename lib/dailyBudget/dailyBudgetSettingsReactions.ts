import type { SettingsPort } from '../ports/homeyRuntime';
import type { DailyBudgetService } from './dailyBudgetService';
import type { DailyBudgetUpdateStateOptions } from './dailyBudgetTypes';
import { createDebouncedSyncScheduler, type DebouncedSyncScheduler } from '../utils/settingsHandlerDebounce';
import type { BudgetSettingsReactions } from '../utils/settingsHandlers';
import { recordSettingsRebuildRequest } from '../utils/settingsRebuildRequest';
import {
  DAILY_BUDGET_ENABLED, DAILY_BUDGET_KWH, DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT, DAILY_BUDGET_PRICE_FLEX_SHARE, DAILY_BUDGET_RESET,
} from '../utils/settingsKeys';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';

const logger = getLogger('settings');
const FORCE_STATE_PERSIST: DailyBudgetUpdateStateOptions = { forcePlanRebuild: true, persistReason: 'manual' };
const CONFIG_KEYS = [
  DAILY_BUDGET_ENABLED, DAILY_BUDGET_KWH, DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT, DAILY_BUDGET_PRICE_FLEX_SHARE,
] as const;

/** Owns config coalescing, reset and persistence policy for settings-driven budget updates. */
export class DailyBudgetSettingsReactions implements BudgetSettingsReactions {
  readonly handlers: BudgetSettingsReactions['handlers'];
  private readonly scheduler: DebouncedSyncScheduler;

  constructor(
    private readonly service: Pick<DailyBudgetService, 'loadSettings' | 'resetLearning'>,
    private readonly updateState: (options: DailyBudgetUpdateStateOptions) => void,
    private readonly settings: SettingsPort,
    private readonly rebuildPlan: (settingsSource: string) => Promise<void>,
  ) {
    this.scheduler = createDebouncedSyncScheduler({
      debounceMs: 500,
      rerunAfterRun: 'immediate',
      run: async () => {
        this.service.loadSettings();
        this.refresh();
        await this.rebuild('daily_budget_settings');
      },
      onError: (error) => logger.error({ event: 'daily_budget_settings_sync_failed', err: normalizeError(error) }),
    });
    this.handlers = {
      ...Object.fromEntries(CONFIG_KEYS.map(key => [key, async () => { void this.scheduler.schedule(); }])),
      [DAILY_BUDGET_RESET]: async () => {
        this.service.resetLearning();
        this.refresh();
        this.settings.set(DAILY_BUDGET_RESET, null);
        await this.rebuild('daily_budget_reset');
      },
    };
  }

  refresh(): void { this.updateState(FORCE_STATE_PERSIST); }

  stop(): void { this.scheduler.stop(); }

  private async rebuild(source: string): Promise<void> {
    recordSettingsRebuildRequest(source);
    await this.rebuildPlan(source);
  }
}
