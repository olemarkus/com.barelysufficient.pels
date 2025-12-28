import type Homey from 'homey';
import type { PowerTrackerState } from '../core/powerTracker';
import { isFiniteNumber } from '../utils/appTypeGuards';
import {
  DAILY_BUDGET_AGGRESSIVENESS,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_STATE,
} from '../utils/settingsKeys';
import { DailyBudgetManager } from './dailyBudgetManager';
import type { CombinedPriceData } from './dailyBudgetManager';
import type { DailyBudgetSettings, DailyBudgetUiPayload } from './dailyBudgetTypes';

type DailyBudgetServiceDeps = {
  homey: Homey.App['homey'];
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  getPowerTracker: () => PowerTrackerState;
  getPriceOptimizationEnabled: () => boolean;
};

export class DailyBudgetService {
  private manager: DailyBudgetManager;
  private settings: DailyBudgetSettings = {
    enabled: false,
    dailyBudgetKWh: 0,
    aggressiveness: 'balanced',
    priceShapingEnabled: true,
  };
  private snapshot: DailyBudgetUiPayload | null = null;

  constructor(private deps: DailyBudgetServiceDeps) {
    this.manager = new DailyBudgetManager({
      log: (...args: unknown[]) => this.deps.log(...args),
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
    });
  }

  loadSettings(): void {
    const enabled = this.deps.homey.settings.get(DAILY_BUDGET_ENABLED) as unknown;
    const budgetKWh = this.deps.homey.settings.get(DAILY_BUDGET_KWH) as unknown;
    const aggressiveness = this.deps.homey.settings.get(DAILY_BUDGET_AGGRESSIVENESS) as unknown;
    const priceShapingEnabled = this.deps.homey.settings.get(DAILY_BUDGET_PRICE_SHAPING_ENABLED) as unknown;
    const resolvedAggressiveness = typeof aggressiveness === 'string'
      && ['relaxed', 'balanced', 'strict'].includes(aggressiveness)
      ? aggressiveness as DailyBudgetSettings['aggressiveness']
      : 'balanced';
    this.settings = {
      enabled: enabled === true,
      dailyBudgetKWh: isFiniteNumber(budgetKWh) ? Math.max(0, budgetKWh) : 0,
      aggressiveness: resolvedAggressiveness,
      priceShapingEnabled: priceShapingEnabled !== false,
    };
  }

  loadState(): void {
    this.manager.loadState(this.deps.homey.settings.get(DAILY_BUDGET_STATE));
  }

  updateState(params: { nowMs?: number; forcePlanRebuild?: boolean } = {}): void {
    const nowMs = params.nowMs ?? Date.now();
    const timeZone = this.deps.homey.clock.getTimezone() || 'Europe/Oslo';
    const combinedPrices = this.deps.homey.settings.get('combined_prices') as CombinedPriceData | null;
    const update = this.manager.update({
      nowMs,
      timeZone,
      settings: this.settings,
      powerTracker: this.deps.getPowerTracker(),
      combinedPrices,
      priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
      forcePlanRebuild: params.forcePlanRebuild,
    });
    this.snapshot = update.snapshot;
    if (update.shouldPersist) {
      this.persistState();
    }
  }

  persistState(): void {
    this.deps.homey.settings.set(DAILY_BUDGET_STATE, this.manager.exportState());
  }

  resetLearning(): void {
    this.manager.resetLearning();
    this.persistState();
  }

  getSnapshot(): DailyBudgetUiPayload | null {
    return this.snapshot;
  }

  getUiPayload(): DailyBudgetUiPayload | null {
    this.updateState({ forcePlanRebuild: false });
    return this.snapshot;
  }
}
