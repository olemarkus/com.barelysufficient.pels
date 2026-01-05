import type Homey from 'homey';
import type { PowerTrackerState } from '../core/powerTracker';
import { isFiniteNumber } from '../utils/appTypeGuards';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import {
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_STATE,
} from '../utils/settingsKeys';
import { MAX_DAILY_BUDGET_KWH, MIN_DAILY_BUDGET_KWH } from './dailyBudgetConstants';
import { DailyBudgetManager } from './dailyBudgetManager';
import type { CombinedPriceData } from './dailyBudgetManager';
import type { DailyBudgetDayPayload, DailyBudgetSettings, DailyBudgetUiPayload } from './dailyBudgetTypes';

type DailyBudgetServiceDeps = {
  homey: Homey.App['homey'];
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  getPowerTracker: () => PowerTrackerState;
  getPriceOptimizationEnabled: () => boolean;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
};

export class DailyBudgetService {
  private manager: DailyBudgetManager;
  private settings: DailyBudgetSettings = {
    enabled: false,
    dailyBudgetKWh: 0,
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
    const priceShapingEnabled = this.deps.homey.settings.get(DAILY_BUDGET_PRICE_SHAPING_ENABLED) as unknown;
    const rawBudget = isFiniteNumber(budgetKWh) ? Math.max(0, budgetKWh) : 0;
    const boundedBudget = rawBudget === 0
      ? 0
      : Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, rawBudget));
    this.settings = {
      enabled: enabled === true,
      dailyBudgetKWh: boundedBudget,
      priceShapingEnabled: priceShapingEnabled !== false,
    };
  }

  loadState(): void {
    this.manager.loadState(this.deps.homey.settings.get(DAILY_BUDGET_STATE));
  }

  private resolveTimeZone(): string {
    try {
      const tz = this.deps.homey.clock?.getTimezone?.();
      if (typeof tz === 'string' && tz.trim()) return tz;
    } catch (error) {
      this.deps.log('Daily budget: failed to read timezone', error);
    }
    return 'Europe/Oslo';
  }

  updateState(params: { nowMs?: number; forcePlanRebuild?: boolean } = {}): void {
    const nowMs = params.nowMs ?? Date.now();
    const timeZone = this.resolveTimeZone();
    const combinedPrices = this.deps.homey.settings.get('combined_prices') as CombinedPriceData | null;
    const capacity = this.deps.getCapacitySettings();
    const capacityBudgetKWh = Math.max(0, capacity.limitKw);
    try {
      const update = this.manager.update({
        nowMs,
        timeZone,
        settings: this.settings,
        powerTracker: this.deps.getPowerTracker(),
        combinedPrices,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        forcePlanRebuild: params.forcePlanRebuild,
        capacityBudgetKWh,
      });
      this.snapshot = update.snapshot;
      if (update.shouldPersist) {
        this.persistState();
      }
    } catch (error) {
      this.deps.log('Daily budget: failed to update state', error);
    }
  }

  persistState(): void {
    this.deps.homey.settings.set(DAILY_BUDGET_STATE, this.manager.exportState());
  }

  resetLearning(): void {
    this.manager.resetLearning();
    this.persistState();
  }

  private buildTomorrowPreview(nowMs: number): DailyBudgetDayPayload | null {
    try {
      const timeZone = this.resolveTimeZone();
      const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
      const todayStartUtcMs = getDateKeyStartMs(todayKey, timeZone);
      const tomorrowStartUtcMs = getNextLocalDayStartUtcMs(todayStartUtcMs, timeZone);
      const combinedPrices = this.deps.homey.settings.get('combined_prices') as CombinedPriceData | null;
      const capacity = this.deps.getCapacitySettings();
      const capacityBudgetKWh = Math.max(0, capacity.limitKw);
      return this.manager.buildPreview({
        dayStartUtcMs: tomorrowStartUtcMs,
        timeZone,
        settings: this.settings,
        combinedPrices,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        capacityBudgetKWh,
      });
    } catch (error) {
      this.deps.log('Daily budget: failed to build tomorrow preview', error);
      return null;
    }
  }

  getSnapshot(): DailyBudgetUiPayload | null {
    return this.snapshot;
  }

  getPeriodicStatusLog(): string | null {
    const nowMs = Date.now();
    this.updateState({ nowMs, forcePlanRebuild: false });
    const snapshot = this.snapshot;
    if (!snapshot || !snapshot.budget.enabled) return null;
    const plannedKWh = snapshot.buckets?.plannedKWh ?? [];
    const currentIndex = snapshot.currentBucketIndex ?? 0;
    const plannedNow = plannedKWh[currentIndex] ?? 0;
    const actualNow = snapshot.buckets?.actualKWh?.[currentIndex];
    const currentUsage = typeof actualNow === 'number' && Number.isFinite(actualNow) ? actualNow : 0;
    const plannedRemaining = plannedKWh
      .slice(currentIndex + 1)
      .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
      + Math.max(0, plannedNow - currentUsage);
    const originalBudget = snapshot.budget.dailyBudgetKWh;
    const usedNow = snapshot.state.usedNowKWh;
    const allowedNow = snapshot.state.allowedNowKWh;
    const currentBudget = usedNow + plannedRemaining;
    const remainingOriginal = originalBudget - usedNow;
    const remainingNew = plannedRemaining;
    return (
      `Daily budget: original=${originalBudget.toFixed(2)}kWh, `
      + `current=${currentBudget.toFixed(2)}kWh, `
      + `actual=${usedNow.toFixed(2)}kWh, `
      + `budgeted=${allowedNow.toFixed(2)}kWh, `
      + `remaining(original)=${remainingOriginal.toFixed(2)}kWh, `
      + `remaining(new)=${remainingNew.toFixed(2)}kWh`
    );
  }

  getUiPayload(): DailyBudgetUiPayload | null {
    const nowMs = Date.now();
    this.updateState({ nowMs, forcePlanRebuild: false });
    if (!this.snapshot) return null;
    return {
      ...this.snapshot,
      tomorrow: this.buildTomorrowPreview(nowMs),
    };
  }
}
