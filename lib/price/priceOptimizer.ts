import type { CombinedHourlyPrice } from './priceTypes';
import { PriceLevel } from './priceLevels';
import { incPerfCounters } from '../utils/perfCounters';
import { startRuntimeSpan } from '../utils/runtimeTrace';

export type PriceOptimizationSettings = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
};

export type PriceOptimizerDeps = {
  priceStatus: {
    getCurrentLevel: () => PriceLevel;
    isCurrentHourCheap: () => boolean;
    isCurrentHourExpensive: () => boolean;
    getCombinedHourlyPrices: () => CombinedHourlyPrice[];
    getCurrentHourPriceInfo: () => string;
    getCurrentHourStartMs: () => number;
  };
  getSettings: () => Record<string, PriceOptimizationSettings>;
  isEnabled: () => boolean;
  getThresholdPercent: () => number;
  getMinDiffOre: () => number;
  rebuildPlan: (reason: string) => Promise<void>;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class PriceOptimizer {
  private interval?: ReturnType<typeof setInterval>;
  private startTimeout?: ReturnType<typeof setTimeout>;

  constructor(private deps: PriceOptimizerDeps) {}

  async applyOnce(): Promise<void> {
    const stopSpan = startRuntimeSpan('price_optimizer_apply');
    try {
      if (!this.deps.isEnabled()) {
        this.deps.logDebug('Price optimization: Disabled globally');
        return;
      }

      const settings = this.deps.getSettings();
      if (!settings || Object.keys(settings).length === 0) {
        this.deps.log('Price optimization: No devices configured');
        return;
      }

      const resolvedLevel = this.deps.priceStatus.getCurrentLevel();
      const isCheap = resolvedLevel === PriceLevel.CHEAP || this.deps.priceStatus.isCurrentHourCheap();
      const isExpensive = resolvedLevel === PriceLevel.EXPENSIVE || this.deps.priceStatus.isCurrentHourExpensive();

      const prices = this.deps.priceStatus.getCombinedHourlyPrices();
      const currentHourStartMs = this.deps.priceStatus.getCurrentHourStartMs();
      const currentPrice = prices.find((p) => new Date(p.startsAt).getTime() === currentHourStartMs);
      const avgPrice = prices.length > 0 ? prices.reduce((sum, p) => sum + p.totalPrice, 0) / prices.length : 0;
      const thresholdPercent = this.deps.getThresholdPercent();
      const minDiffOre = this.deps.getMinDiffOre();
      const currentPriceStr = currentPrice?.totalPrice?.toFixed(1) ?? 'N/A';
      this.deps.log(
        `Price optimization: current=${currentPriceStr} øre, avg=${avgPrice.toFixed(1)} øre, `
        + `threshold=${thresholdPercent}%, minDiff=${minDiffOre} øre, isCheap=${isCheap}, `
        + `isExpensive=${isExpensive}, devices=${Object.keys(settings).length}`,
      );

      let hourLabel = 'normal';
      if (isCheap) {
        hourLabel = 'cheap';
      } else if (isExpensive) {
        hourLabel = 'expensive';
      }
      incPerfCounters([
        'plan_rebuild_requested_total',
        'plan_rebuild_requested.price_optimizer_total',
        `plan_rebuild_requested.price_optimizer.${hourLabel}_total`,
      ]);
      await this.deps.rebuildPlan(`price optimization (${hourLabel} hour)`);
    } finally {
      stopSpan();
    }
  }

  async start(applyImmediately = true): Promise<void> {
    this.stop();
    if (applyImmediately) {
      await this.applyOnce();
    }
    this.scheduleHourly();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = undefined;
    }
  }

  private scheduleHourly(): void {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const msUntilNextHour = nextHour.getTime() - now.getTime();

    this.startTimeout = setTimeout(() => {
      this.applyOnce().catch((error: Error) => {
        this.deps.error('Price optimization failed', error);
      });

      this.interval = setInterval(() => {
        this.applyOnce().catch((error: Error) => {
          this.deps.error('Price optimization failed', error);
        });
      }, 60 * 60 * 1000);
    }, msUntilNextHour);
  }
}
