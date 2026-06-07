import type { CombinedHourlyPrice } from './priceTypes';
import { PriceLevel } from './priceLevels';
import { incPerfCounters, addPerfDuration } from '../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../utils/opRssTracker';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import { normalizeError } from '../utils/errorUtils';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';

const moduleLogger = getLogger('price/optimizer');

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
  debugStructured: StructuredDebugEmitter;
  structuredLog?: PinoLogger;
};

export class PriceOptimizer {
  private interval?: ReturnType<typeof setInterval>;
  private startTimeout?: ReturnType<typeof setTimeout>;
  private lastMode: string | null = null;

  constructor(private deps: PriceOptimizerDeps) {}

  /* eslint-disable-next-line max-statements -- adds 3 instrumentation statements (timing + RSS sampling). */
  async applyOnce(): Promise<void> {
    const stopSpan = startRuntimeSpan('price_optimizer_apply');
    const opStart = Date.now();
    const rssBefore = safeRss();
    try {
      if (!this.deps.isEnabled()) {
        this.deps.debugStructured({ event: 'price_optimization_disabled_globally' });
        this.lastMode = null;
        return;
      }

      const settings = this.deps.getSettings();
      if (!settings || Object.keys(settings).length === 0) {
        (this.deps.structuredLog ?? moduleLogger).info({ event: 'price_optimization_no_devices_configured' });
        this.lastMode = null;
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
      const resultingMode = PriceOptimizer.resolveHourLabel(isCheap, isExpensive);
      const previousMode = this.lastMode;
      (this.deps.structuredLog ?? moduleLogger).info({
        event: 'price_optimization_completed',
        previousMode,
        resultingMode,
        mode: resultingMode,
        transition: previousMode === resultingMode ? 'steady' : 'hour_boundary_transition',
        devicesCount: Object.keys(settings).length,
        currentPriceAvailable: currentPrice != null,
        currentPriceOre: currentPrice?.totalPrice ?? null,
        avgPriceOre: Math.round(avgPrice * 10) / 10,
        thresholdPercent,
        minDiffOre,
        isCheap,
        isExpensive,
      });
      this.lastMode = resultingMode;
      incPerfCounters([
        'plan_rebuild_requested_total',
        'plan_rebuild_requested.price_optimizer_total',
        `plan_rebuild_requested.price_optimizer.${resultingMode}_total`,
      ]);
      await this.deps.rebuildPlan(`price optimization (${resultingMode} hour)`);
    } finally {
      stopSpan();
      addPerfDuration('price_optimizer_apply_ms', Date.now() - opStart);
      recordOpRssDelta('price_optimizer_apply_ms', rssBefore, safeRss());
    }
  }

  async start(applyImmediately = true): Promise<void> {
    this.stop();
    if (applyImmediately) {
      await this.applyOnce();
    }
    this.scheduleHourly();
  }

  private static resolveHourLabel(isCheap: boolean, isExpensive: boolean): string {
    if (isCheap) return 'cheap';
    if (isExpensive) return 'expensive';
    return 'normal';
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
        (this.deps.structuredLog ?? moduleLogger).error({
          event: 'price_optimization_failed',
          err: normalizeError(error),
        });
      });

      this.interval = setInterval(() => {
        this.applyOnce().catch((error: Error) => {
          (this.deps.structuredLog ?? moduleLogger).error({
            event: 'price_optimization_failed',
            err: normalizeError(error),
          });
        });
      }, 60 * 60 * 1000);
    }, msUntilNextHour);
  }
}
