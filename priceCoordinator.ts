import Homey from 'homey';
import { PriceOptimizer } from './priceOptimizer';
import { PriceLevel } from './priceLevels';
import PriceService from './priceService';

export type PriceCoordinatorDeps = {
  homey: Homey.App['homey'];
  getCurrentPriceLevel: () => PriceLevel;
  rebuildPlanFromCache: (reason: string) => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class PriceCoordinator {
  private priceService: PriceService;
  private priceOptimizer?: PriceOptimizer;
  private priceRefreshInterval?: ReturnType<typeof setInterval>;
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
    );
  }

  getPriceOptimizationEnabled(): boolean {
    return this.priceOptimizationEnabled;
  }

  getPriceOptimizationSettings(): Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }> {
    return this.priceOptimizationSettings;
  }

  updatePriceOptimizationEnabled(logChange = false): void {
    const enabled = this.deps.homey.settings.get('price_optimization_enabled') as unknown;
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
      },
      getSettings: () => this.priceOptimizationSettings,
      isEnabled: () => this.priceOptimizationEnabled,
      getThresholdPercent: () => this.deps.homey.settings.get('price_threshold_percent') ?? 25,
      getMinDiffOre: () => this.deps.homey.settings.get('price_min_diff_ore') ?? 0,
      rebuildPlan: (reason) => {
        this.deps.logDebug(`Price optimization: triggering plan rebuild (${reason})`);
        this.deps.rebuildPlanFromCache(reason);
      },
      log: (...args: unknown[]) => this.deps.log(...args),
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
      error: (...args: unknown[]) => this.deps.error(...args),
    });
  }

  async applyPriceOptimization(): Promise<void> {
    await this.priceOptimizer?.applyOnce();
  }

  async startPriceOptimization(): Promise<void> {
    await this.priceOptimizer?.start();
  }

  stop(): void {
    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
      this.priceRefreshInterval = undefined;
    }
    this.priceOptimizer?.stop();
  }

  startPriceRefresh(): void {
    // Refresh prices every 3 hours
    const refreshIntervalMs = 3 * 60 * 60 * 1000;

    this.priceRefreshInterval = setInterval(() => {
      this.priceService.refreshSpotPrices().catch((error: Error) => {
        this.deps.error('Failed to refresh spot prices', error);
      });
      this.priceService.refreshNettleieData().catch((error: Error) => {
        this.deps.error('Failed to refresh nettleie data', error);
      });
    }, refreshIntervalMs);
  }

  async refreshSpotPrices(forceRefresh = false): Promise<void> {
    await this.priceService.refreshSpotPrices(forceRefresh);
  }

  async refreshNettleieData(forceRefresh = false): Promise<void> {
    await this.priceService.refreshNettleieData(forceRefresh);
  }

  updateCombinedPrices(): void {
    this.priceService.updateCombinedPrices();
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
