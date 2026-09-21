import type { CombinedPricePeriod } from './priceTypes';
import { getCurrentPricePeriod, resolveCurrentPricePeriodLevel } from './priceLevelUtils';
import { calculateDurationWeightedAveragePrice } from './priceMath';
import { resolvePlanningPrice } from './budgetPrice';
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
  // Surplus-absorb rides this same per-device blob (a distinct cause from price —
  // triggered by exporting, not a cheap hour). `surplusWilling` opts the device in;
  // `surplusDelta` is the raise-only setpoint lift (°C). The settings adapter
  // resolves legacy omissions before this value reaches business logic.
  surplusWilling: boolean;
  surplusDelta: number;
};

/**
 * One device's price-optimization entry with nothing left to interpret: a
 * device with no entry is not price-aware and has no lift, and a lift the owner
 * did not opt into, or one that is not a positive number, is no lift.
 */
export type ResolvedPriceOptimizationConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  /** The surplus setpoint lift in °C; 0 for a device with no lift. */
  surplusLiftC: number;
};

const NOT_PRICE_AWARE: ResolvedPriceOptimizationConfig = {
  enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusLiftC: 0,
};

export function resolvePriceOptimizationConfig(
  settings: Readonly<Record<string, PriceOptimizationSettings>>,
  deviceId: string,
): ResolvedPriceOptimizationConfig {
  // Own keys only: a device id naming an Object.prototype member has no entry.
  if (!Object.hasOwn(settings, deviceId)) return NOT_PRICE_AWARE;
  const { enabled, cheapDelta, expensiveDelta, surplusWilling, surplusDelta } = settings[deviceId]!;
  const lifts = surplusWilling && surplusDelta > 0;
  return { enabled, cheapDelta, expensiveDelta, surplusLiftC: lifts ? surplusDelta : 0 };
}

export type PriceOptimizerDeps = {
  priceStatus: {
    getCombinedPricePeriods: () => CombinedPricePeriod[];
  };
  getSettings: () => Record<string, PriceOptimizationSettings>;
  isEnabled: () => boolean;
  getThresholdPercent: () => number;
  getMinDiffOre: () => number;
  /** Names the price MODE that just resolved (`cheap` / `expensive` / `normal`). */
  rebuildPlan: (priceMode: string) => Promise<void>;
  debugStructured: StructuredDebugEmitter;
  structuredLog?: PinoLogger;
};

export class PriceOptimizer {
  private startTimeout?: ReturnType<typeof setTimeout>;
  private lastMode: string | null = null;
  /**
   * Teardown can land before `start()` ever gets to arm a timer: starting the
   * optimizer waits on two network refreshes first, and `stop()` in that window
   * has no handle to clear. Without this the chain would arm itself afterwards
   * and keep re-arming — rebuilding plans on a torn-down app forever.
   */
  private stopped = false;
  /**
   * Which `start()` the live chain belongs to. Two starts can overlap while the
   * first is still awaiting its `applyOnce()`, and both would then arm a timer —
   * the second overwrites the handle while the first keeps re-arming itself,
   * unstoppable. A firing chain that is not the current generation retires.
   */
  private generation = 0;

  constructor(private deps: PriceOptimizerDeps) {}

  async applyOnce(): Promise<void> {
    const stopSpan = startRuntimeSpan('price_optimizer_apply');
    const opStart = Date.now();
    const rssBefore = safeRss();
    try {
      await this.applyOnceCore();
    } finally {
      stopSpan();
      addPerfDuration('price_optimizer_apply_ms', Date.now() - opStart);
      recordOpRssDelta('price_optimizer_apply_ms', rssBefore, safeRss());
    }
  }

  private async applyOnceCore(): Promise<void> {
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

    // One series for the whole tick. Building it is uncached and costs ~25 ms
    // (see `resolveCurrentPricePeriodLevel`), and on a 15-minute zone this runs
    // four times an hour — so the level, the current price and the next boundary
    // are all answered from this one build rather than six.
    const prices = this.deps.priceStatus.getCombinedPricePeriods();
    const thresholdPercent = this.deps.getThresholdPercent();
    const minDiffOre = this.deps.getMinDiffOre();
    const band = { thresholdPercent, minDiff: minDiffOre };

    const resolvedLevel = resolveCurrentPricePeriodLevel(prices, band);
    const isCheap = resolvedLevel === PriceLevel.CHEAP;
    const isExpensive = resolvedLevel === PriceLevel.EXPENSIVE;

    const currentPrice = getCurrentPricePeriod(prices);
    // The same average the classification used: the planning price, weighted by
    // how long each period lasts. A plain per-entry mean over a day that mixes
    // quarters and hours would report a number the verdict was not taken against.
    const avgPrice = calculateDurationWeightedAveragePrice(
      prices,
      (entry) => resolvePlanningPrice(entry.budgetPrice, entry.totalPrice),
      (entry) => entry.durationMinutes,
    );
    const resultingMode = PriceOptimizer.resolvePriceModeLabel(isCheap, isExpensive);
    const previousMode = this.lastMode;
    (this.deps.structuredLog ?? moduleLogger).info({
      event: 'price_optimization_completed',
      previousMode,
      resultingMode,
      mode: resultingMode,
      transition: previousMode === resultingMode ? 'steady' : 'price_period_transition',
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
    await this.deps.rebuildPlan(resultingMode);
  }

  async start(applyImmediately = true): Promise<void> {
    this.stop();
    this.stopped = false;
    const generation = this.nextGeneration();
    if (applyImmediately) {
      await this.applyOnce();
    }
    this.scheduleNextPeriod(generation);
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private static resolvePriceModeLabel(isCheap: boolean, isExpensive: boolean): string {
    if (isCheap) return 'cheap';
    if (isExpensive) return 'expensive';
    return 'normal';
  }

  stop(): void {
    this.stopped = true;
    this.nextGeneration();
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = undefined;
    }
  }

  /**
   * Wake when the price itself changes — at the end of the period now in force,
   * which is the next quarter on a 15-minute zone and the next hour on an hourly
   * one. Each firing schedules the one after it rather than running on a fixed
   * interval, so a zone that changes period length (or a DST hour) is followed
   * rather than drifted past.
   */
  private scheduleNextPeriod(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    const nowMs = Date.now();
    // A whole second short of the boundary would re-read the period that is
    // ending; a second past it is unambiguous and imperceptible to the owner.
    const delayMs = Math.max(1_000, this.resolveNextBoundaryMs(nowMs) + 1_000 - nowMs);
    this.startTimeout = setTimeout(() => {
      this.applyOnce().catch((error: Error) => {
        (this.deps.structuredLog ?? moduleLogger).error({
          event: 'price_optimization_failed',
          err: normalizeError(error),
        });
      });
      this.scheduleNextPeriod(generation);
    }, delayMs);
  }

  /**
   * When the price in force stops being the price in force.
   *
   * Reading the series is a settings read, and a settings read can fail
   * transiently. It must not take the chain with it: an unhandled throw here
   * happens between `applyOnce()` and the next `setTimeout`, so nothing would
   * ever arm again and the app would stop following prices until it restarted.
   * A failed read falls back to the next hour, which is a boundary that exists
   * whether or not prices do.
   */
  private resolveNextBoundaryMs(nowMs: number): number {
    const periods = this.readPeriodsForScheduling();
    const current = getCurrentPricePeriod(periods, nowMs);
    if (current) {
      return new Date(current.startsAt).getTime() + current.durationMinutes * 60 * 1000;
    }
    // Nothing covers now — a gap where one period was dropped, or a series that
    // has not reached this far. The next period that does start is still a real
    // boundary and closer than the hour, so wake there rather than sleeping
    // through it.
    const nextStartMs = periods
      .map((period) => new Date(period.startsAt).getTime())
      .filter((startMs) => Number.isFinite(startMs) && startMs > nowMs)
      .sort((left, right) => left - right)[0];
    const nextHour = new Date(nowMs);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    return nextStartMs !== undefined ? Math.min(nextStartMs, nextHour.getTime()) : nextHour.getTime();
  }

  private readPeriodsForScheduling(): CombinedPricePeriod[] {
    try {
      return this.deps.priceStatus.getCombinedPricePeriods();
    } catch (error: unknown) {
      (this.deps.structuredLog ?? moduleLogger).error({
        event: 'price_period_schedule_read_failed',
        err: normalizeError(error),
      });
      return [];
    }
  }
}
