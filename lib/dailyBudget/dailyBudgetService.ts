import type Homey from 'homey';
import type { PowerTrackerState } from '../core/powerTracker';
import { isFiniteNumber } from '../utils/appTypeGuards';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
} from '../utils/dateUtils';
import {
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_STATE,
} from '../utils/settingsKeys';
import {
  CONTROLLED_USAGE_WEIGHT,
  MAX_DAILY_BUDGET_KWH,
  MIN_DAILY_BUDGET_KWH,
  PRICE_SHAPING_FLEX_SHARE,
} from './dailyBudgetConstants';
import { DailyBudgetManager } from './dailyBudgetManager';
import type { CombinedPriceData } from './dailyBudgetManager';
import type { DailyBudgetDayPayload, DailyBudgetSettings, DailyBudgetUiPayload } from './dailyBudgetTypes';
import { incPerfCounter, addPerfDuration } from '../utils/perfCounters';
import { startRuntimeSpan } from '../utils/runtimeTrace';

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
    controlledUsageWeight: CONTROLLED_USAGE_WEIGHT,
    priceShapingFlexShare: PRICE_SHAPING_FLEX_SHARE,
  };
  private snapshot: DailyBudgetUiPayload | null = null;
  private daySnapshots: Record<string, DailyBudgetDayPayload> = {};

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
    const controlledWeight = this.deps.homey.settings.get(DAILY_BUDGET_CONTROLLED_WEIGHT) as unknown;
    const priceFlexShare = this.deps.homey.settings.get(DAILY_BUDGET_PRICE_FLEX_SHARE) as unknown;
    const rawBudget = isFiniteNumber(budgetKWh) ? Math.max(0, budgetKWh) : 0;
    const boundedBudget = rawBudget === 0
      ? 0
      : Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, rawBudget));
    const boundedControlledWeight = isFiniteNumber(controlledWeight)
      ? Math.min(1, Math.max(0, controlledWeight))
      : CONTROLLED_USAGE_WEIGHT;
    const boundedPriceFlexShare = isFiniteNumber(priceFlexShare)
      ? Math.min(1, Math.max(0, priceFlexShare))
      : PRICE_SHAPING_FLEX_SHARE;
    this.settings = {
      enabled: enabled === true,
      dailyBudgetKWh: boundedBudget,
      priceShapingEnabled: priceShapingEnabled !== false,
      controlledUsageWeight: boundedControlledWeight,
      priceShapingFlexShare: boundedPriceFlexShare,
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

  updateState(params: {
    nowMs?: number;
    forcePlanRebuild?: boolean;
    includeAdjacentDays?: boolean;
    refreshObservedStats?: boolean;
  } = {}): void {
    const stopSpan = startRuntimeSpan('daily_budget_update');
    const start = Date.now();
    const nowMs = params.nowMs ?? Date.now();
    const includeAdjacentDays = params.includeAdjacentDays === true;
    const timeZone = this.resolveTimeZone();
    const combinedPrices = this.deps.homey.settings.get(COMBINED_PRICES) as CombinedPriceData | null;
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
        refreshObservedStats: params.refreshObservedStats,
      });
      this.setDaySnapshot(update.snapshot, nowMs, includeAdjacentDays);
      if (update.shouldPersist) {
        this.persistState();
      }
    } catch (error) {
      this.deps.log('Daily budget: failed to update state', error);
    } finally {
      stopSpan();
      incPerfCounter('daily_budget_update_total');
      addPerfDuration('daily_budget_update_ms', Date.now() - start);
    }
  }

  persistState(): void {
    this.deps.homey.settings.set(DAILY_BUDGET_STATE, this.manager.exportState());
    incPerfCounter('settings_set.daily_budget_state');
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
      const combinedPrices = this.deps.homey.settings.get(COMBINED_PRICES) as CombinedPriceData | null;
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

  private buildYesterdayHistory(nowMs: number): DailyBudgetDayPayload | null {
    const context = this.resolveYesterdayContext(nowMs);
    if (!context) return null;
    const { timeZone, yesterdayStartUtcMs } = context;
    try {
      const combinedPrices = this.deps.homey.settings.get(COMBINED_PRICES) as CombinedPriceData | null;
      return this.manager.buildHistory({
        dayStartUtcMs: yesterdayStartUtcMs,
        timeZone,
        powerTracker: this.deps.getPowerTracker(),
        combinedPrices,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        priceShapingEnabled: this.settings.priceShapingEnabled,
      });
    } catch (error) {
      this.deps.log('Daily budget: failed to build yesterday history', error);
      return null;
    }
  }

  private resolveYesterdayContext(nowMs: number): { timeZone: string; yesterdayStartUtcMs: number } | null {
    try {
      const timeZone = this.resolveTimeZone();
      const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
      const todayStartUtcMs = getDateKeyStartMs(todayKey, timeZone);
      // Go back 12 hours from start of today to ensure we are in yesterday
      const yesterdayMs = todayStartUtcMs - 12 * 60 * 60 * 1000;
      const yesterdayKey = getDateKeyInTimeZone(new Date(yesterdayMs), timeZone);
      const yesterdayStartUtcMs = getDateKeyStartMs(yesterdayKey, timeZone);
      return { timeZone, yesterdayStartUtcMs };
    } catch (error) {
      this.deps.log('Daily budget: failed to resolve yesterday date', error);
      return null;
    }
  }

  getSnapshot(): DailyBudgetUiPayload | null {
    return this.snapshot;
  }

  getPeriodicStatusLog(): string | null {
    const nowMs = Date.now();
    this.updateState({ nowMs, forcePlanRebuild: false });
    const snapshot = this.getTodaySnapshot();
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
    this.updateState({ nowMs, forcePlanRebuild: false, includeAdjacentDays: true });
    if (!this.snapshot) return null;
    return this.snapshot;
  }

  private setDaySnapshot(snapshot: DailyBudgetDayPayload, nowMs: number, includeAdjacentDays = false): void {
    const todayKey = snapshot.dateKey;
    const tomorrowSnapshot = includeAdjacentDays ? this.buildTomorrowPreview(nowMs) : null;
    const tomorrowKey = includeAdjacentDays ? tomorrowSnapshot?.dateKey ?? null : null;
    const yesterdaySnapshot = includeAdjacentDays ? this.buildYesterdayHistory(nowMs) : null;
    const yesterdayKey = includeAdjacentDays ? yesterdaySnapshot?.dateKey ?? null : null;

    this.daySnapshots = includeAdjacentDays
      ? {
        [todayKey]: snapshot,
        ...(tomorrowSnapshot ? { [tomorrowSnapshot.dateKey]: tomorrowSnapshot } : {}),
        ...(yesterdaySnapshot ? { [yesterdaySnapshot.dateKey]: yesterdaySnapshot } : {}),
      }
      : { [todayKey]: snapshot };
    this.snapshot = {
      days: { ...this.daySnapshots },
      todayKey,
      tomorrowKey,
      yesterdayKey,
    };
  }

  private getTodaySnapshot(): DailyBudgetDayPayload | null {
    if (!this.snapshot) return null;
    return this.snapshot.days[this.snapshot.todayKey] ?? null;
  }
}
