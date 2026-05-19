import Homey from 'homey';
import { PriceOptimizer } from './priceOptimizer';
import { PriceLevel } from './priceLevels';
import PriceService from './priceService';
import { PRICE_OPTIMIZATION_ENABLED } from '../utils/settingsKeys';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import { getNextLocalDayStartUtcMs } from '../utils/dateUtils';
import type { Logger as PinoLogger } from '../logging/logger';

// Fire shortly after local midnight so the local-day key has rolled over before
// the rotation reads it. 30s leaves room for clock skew and timer drift.
const MIDNIGHT_ROTATION_OFFSET_MS = 30 * 1000;
// Floor on the scheduled delay to avoid scheduling tight back-to-back timers
// if the previous fire ran slightly early (e.g. 23:59:59.998 local).
const MIDNIGHT_ROTATION_MIN_DELAY_MS = 1000;

export type PriceCoordinatorDeps = {
  homey: Homey.App['homey'];
  getHomeyEnergyApi?: () => import('../utils/homeyEnergy').HomeyEnergyApi | null;
  getCurrentPriceLevel: () => PriceLevel;
  rebuildPlanFromCache: (reason: string) => Promise<void>;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  structuredLog?: PinoLogger;
  onCombinedPricesUpdated?: (reason: string) => void;
};

export class PriceCoordinator {
  private priceService: PriceService;
  private priceOptimizer?: PriceOptimizer;
  private priceRefreshInterval?: ReturnType<typeof setInterval>;
  private midnightRotationTimeout?: ReturnType<typeof setTimeout>;
  // Guards midnight-rotation re-entry. A pending setTimeout may still fire
  // briefly after stop() before clearTimeout takes effect; without this flag
  // the callback would call updateCombinedPrices and reschedule itself.
  private stopped = false;
  private priceOptimizationEnabled = true;
  private priceOptimizationSettings: Record<string, {
    enabled: boolean;
    cheapDelta: number;
    expensiveDelta: number;
  }> = {};

  constructor(private deps: PriceCoordinatorDeps) {
    this.priceService = new PriceService(
      deps.homey,
      deps.log,
      deps.logDebug,
      deps.error,
      deps.getHomeyEnergyApi,
    );
    if (deps.onCombinedPricesUpdated) {
      this.priceService.setOnCombinedPricesUpdated(deps.onCombinedPricesUpdated);
    }
  }

  getPriceOptimizationEnabled(): boolean {
    return this.priceOptimizationEnabled;
  }

  getPriceOptimizationSettings(): Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }> {
    return this.priceOptimizationSettings;
  }

  updatePriceOptimizationEnabled(logChange = false): void {
    const enabled = this.deps.homey.settings.get(PRICE_OPTIMIZATION_ENABLED) as unknown;
    this.priceOptimizationEnabled = enabled !== false;
    if (logChange) {
      this.deps.log(`Price optimization ${this.priceOptimizationEnabled ? 'enabled' : 'disabled'}`);
    }
  }

  loadPriceOptimizationSettings(): void {
    const settings = this.deps.homey.settings.get('price_optimization_settings') as unknown;
    if (isPriceOptimizationSettings(settings)) {
      this.priceOptimizationSettings = settings;
    }
  }

  initOptimizer(): void {
    this.priceOptimizer = new PriceOptimizer({
      priceStatus: {
        getCurrentLevel: () => this.deps.getCurrentPriceLevel(),
        isCurrentHourCheap: () => this.isCurrentHourCheap(),
        isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
        getCombinedHourlyPrices: () => this.getCombinedHourlyPrices(),
        getCurrentHourPriceInfo: () => this.getCurrentHourPriceInfo(),
        getCurrentHourStartMs: () => this.getCurrentHourStartMs(),
      },
      getSettings: () => this.priceOptimizationSettings,
      isEnabled: () => this.priceOptimizationEnabled,
      getThresholdPercent: () => this.deps.homey.settings.get('price_threshold_percent') ?? 25,
      getMinDiffOre: () => this.deps.homey.settings.get('price_min_diff_ore') ?? 0,
      rebuildPlan: async (reason) => {
        this.deps.logDebug(`Price optimization: triggering plan rebuild (${reason})`);
        await this.deps.rebuildPlanFromCache(reason);
      },
      log: (...args: unknown[]) => this.deps.log(...args),
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
      error: (...args: unknown[]) => this.deps.error(...args),
      structuredLog: this.deps.structuredLog,
    });
  }

  async applyPriceOptimization(): Promise<void> {
    await this.priceOptimizer?.applyOnce();
  }

  async startPriceOptimization(applyImmediately = true): Promise<void> {
    await this.priceOptimizer?.start(applyImmediately);
  }

  stop(): void {
    this.stopped = true;
    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
      this.priceRefreshInterval = undefined;
    }
    if (this.midnightRotationTimeout) {
      clearTimeout(this.midnightRotationTimeout);
      this.midnightRotationTimeout = undefined;
    }
    this.priceOptimizer?.stop();
  }

  startPriceRefresh(): void {
    this.stopped = false;
    // Refresh prices every 3 hours
    const refreshIntervalMs = 3 * 60 * 60 * 1000;

    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
    }
    this.priceRefreshInterval = setInterval(() => {
      this.refreshSpotPrices().catch(() => {});
      this.refreshGridTariffData().catch(() => {});
    }, refreshIntervalMs);
    // Flow-scheme price slots only rotate when an external trigger (push, settings change,
    // UI fetch) calls updateCombinedPrices. Without a midnight nudge, COMBINED_PRICES keeps
    // yesterday's isCheap/isExpensive classification until the next push, so flow-only users
    // see stale price tiers post-midnight. Schedule a one-shot nudge per local midnight.
    this.scheduleNextMidnightRotation();
  }

  private scheduleNextMidnightRotation(): void {
    if (this.stopped) return;
    if (this.midnightRotationTimeout) {
      clearTimeout(this.midnightRotationTimeout);
      this.midnightRotationTimeout = undefined;
    }
    const delayMs = this.computeMidnightRotationDelayMs(new Date());
    this.midnightRotationTimeout = setTimeout(() => {
      this.midnightRotationTimeout = undefined;
      if (this.stopped) return;
      try {
        this.updateCombinedPrices();
      } catch (error) {
        this.deps.error('Midnight price rotation failed', error);
      } finally {
        this.scheduleNextMidnightRotation();
      }
    }, delayMs);
  }

  private computeMidnightRotationDelayMs(now: Date): number {
    const timeZone = this.deps.homey.clock.getTimezone();
    const targetMs = getNextLocalDayStartUtcMs(now.getTime(), timeZone) + MIDNIGHT_ROTATION_OFFSET_MS;
    return Math.max(MIDNIGHT_ROTATION_MIN_DELAY_MS, targetMs - now.getTime());
  }

  async refreshSpotPrices(forceRefresh = false): Promise<void> {
    const stopSpan = startRuntimeSpan('price_refresh_spot');
    try {
      await this.priceService.refreshSpotPrices(forceRefresh);
    } catch (error) {
      throw this.reportPriceFetchFailure('spot', error);
    } finally {
      stopSpan();
    }
  }

  async refreshGridTariffData(forceRefresh = false): Promise<void> {
    const stopSpan = startRuntimeSpan('price_refresh_tariff');
    try {
      await this.priceService.refreshGridTariffData(forceRefresh);
    } catch (error) {
      throw this.reportPriceFetchFailure('grid_tariff', error);
    } finally {
      stopSpan();
    }
  }

  updateCombinedPrices(): void {
    this.priceService.updateCombinedPrices();
  }

  storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  } {
    return this.priceService.storeFlowPriceData(kind, raw);
  }

  getCombinedHourlyPrices() {
    return this.priceService.getCombinedHourlyPrices();
  }

  findCheapestHours(count: number): string[] {
    return this.priceService.findCheapestHours(count);
  }

  isCurrentHourCheap(): boolean {
    return this.priceService.isCurrentHourCheap();
  }

  isCurrentHourExpensive(): boolean {
    return this.priceService.isCurrentHourExpensive();
  }

  getCurrentHourPriceInfo(): string {
    return this.priceService.getCurrentHourPriceInfo();
  }

  getCurrentHourStartMs(): number {
    return this.priceService.getCurrentHourStartMs();
  }

  private reportPriceFetchFailure(priceSource: 'spot' | 'grid_tariff', error: unknown): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    const label = priceSource === 'spot' ? 'spot prices' : 'grid tariff data';
    this.deps.error(`Failed to refresh ${label}`, err);
    this.deps.structuredLog?.error({
      event: 'price_fetch_failed',
      priceSource,
      reasonCode: resolveErrorReasonCode(err),
    });
    return err;
  }
}

function resolveErrorReasonCode(error: Error): string {
  const anyError = error as { message?: unknown; code?: unknown };
  const code = typeof anyError.code === 'string' ? anyError.code.toUpperCase() : undefined;
  const msg = typeof anyError.message === 'string' ? anyError.message : '';
  const msgLower = msg.toLowerCase();

  if (code === 'ETIMEDOUT') {
    return 'request_timeout';
  }
  if (code === 'ECONNRESET') {
    return 'socket_hangup';
  }
  if (msgLower.includes('timeout')) {
    return 'request_timeout';
  }
  if (msgLower.includes('socket hang up')) {
    return 'socket_hangup';
  }
  if (msgLower.includes('cert') || msgLower.includes('ssl')) {
    return 'ssl_verification_failed';
  }
  return 'price_fetch_failed';
}

function isPriceOptimizationSettings(
  value: unknown,
): value is Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as { enabled?: unknown; cheapDelta?: unknown; expensiveDelta?: unknown };
    return typeof record.enabled === 'boolean'
      && typeof record.cheapDelta === 'number'
      && typeof record.expensiveDelta === 'number';
  });
}
