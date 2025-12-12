/* eslint-disable @typescript-eslint/no-explicit-any -- Homey APIs are untyped */
import { CombinedHourlyPrice } from './priceService';
import { TargetDeviceSnapshot } from './types';
import { PriceLevel } from './priceLevels';

export interface PriceOptimizationSettings {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
}

export interface PriceOptimizerDeps {
  priceStatus: {
    getCurrentLevel: () => PriceLevel;
    isCurrentHourCheap: () => boolean;
    isCurrentHourExpensive: () => boolean;
    getCombinedHourlyPrices: () => CombinedHourlyPrice[];
    getCurrentHourPriceInfo: () => string;
  };
  getSettings: () => Record<string, PriceOptimizationSettings>;
  getSnapshot: () => TargetDeviceSnapshot[];
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  isDryRun: () => boolean;
  isEnabled: () => boolean;
  getThresholdPercent: () => number;
  getMinDiffOre: () => number;
  setDeviceTarget: (deviceId: string, capabilityId: string, value: number) => Promise<void>;
  updateLocalSnapshot: (deviceId: string, updates: { target?: number | null; on?: boolean }) => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export class PriceOptimizer {
  private interval?: ReturnType<typeof setInterval>;
  private startTimeout?: ReturnType<typeof setTimeout>;

  constructor(private deps: PriceOptimizerDeps) {}

  async applyOnce(): Promise<void> {
    if (!this.deps.isEnabled()) {
      this.deps.logDebug('Price optimization: Disabled globally');
      return;
    }

    const settings = this.deps.getSettings();
    if (!settings || Object.keys(settings).length === 0) {
      this.deps.log('Price optimization: No devices configured');
      return;
    }

    const snapshot = this.deps.getSnapshot();
    const resolvedLevel = this.deps.priceStatus.getCurrentLevel();
    const isCheap = resolvedLevel === PriceLevel.CHEAP || this.deps.priceStatus.isCurrentHourCheap();
    const isExpensive = resolvedLevel === PriceLevel.EXPENSIVE || this.deps.priceStatus.isCurrentHourExpensive();

    const prices = this.deps.priceStatus.getCombinedHourlyPrices();
    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);
    const currentPrice = prices.find((p) => new Date(p.startsAt).getTime() === currentHourStart.getTime());
    const avgPrice = prices.length > 0 ? prices.reduce((sum, p) => sum + p.totalPrice, 0) / prices.length : 0;
    const thresholdPercent = this.deps.getThresholdPercent();
    const minDiffOre = this.deps.getMinDiffOre();
    const currentPriceStr = currentPrice?.totalPrice?.toFixed(1) ?? 'N/A';
    this.deps.log(
      `Price optimization: current=${currentPriceStr} øre, avg=${avgPrice.toFixed(1)} øre, `
      + `threshold=${thresholdPercent}%, minDiff=${minDiffOre} øre, isCheap=${isCheap}, `
      + `isExpensive=${isExpensive}, devices=${Object.keys(settings).length}`,
    );

    const priceState = isCheap ? PriceLevel.CHEAP : isExpensive ? PriceLevel.EXPENSIVE : PriceLevel.NORMAL;
    const priceStateStr = priceState;
    const modeTargets = this.deps.getModeDeviceTargets();
    const currentMode = this.deps.getOperatingMode() || 'Home';

    for (const [deviceId, config] of Object.entries(settings)) {
      if (!config.enabled) continue;

      const device = snapshot.find((d) => d.id === deviceId);
      if (!device || !device.targets || device.targets.length === 0) {
        this.deps.logDebug(`Price optimization: Device ${device?.name || deviceId} not found or has no target capability`);
        continue;
      }

      const baseTemp = modeTargets[currentMode]?.[deviceId];
      if (baseTemp === undefined) {
        this.deps.logDebug(`Price optimization: No mode target for ${device.name} in mode ${currentMode}`);
        continue;
      }

      let targetTemp = baseTemp;
      if (isCheap && config.cheapDelta) {
        targetTemp = baseTemp + config.cheapDelta;
      } else if (isExpensive && config.expensiveDelta) {
        targetTemp = baseTemp + config.expensiveDelta;
      }

      const targetCap = device.targets[0].id;
      const currentTarget = device.targets[0].value;

      if (currentTarget === targetTemp) {
        this.deps.logDebug(`Price optimization: ${device.name} already at ${targetTemp}°C`);
        continue;
      }

      const deltaInfo = isCheap ? `+${config.cheapDelta}` : isExpensive ? `${config.expensiveDelta}` : '0';
    const priceInfo = this.deps.priceStatus.getCurrentHourPriceInfo();

      if (this.deps.isDryRun()) {
        this.deps.log(`Price optimization (dry run): Would set ${device.name} to ${targetTemp}°C (${priceStateStr} hour, delta ${deltaInfo}, base ${baseTemp}°C, ${priceInfo})`);
        continue;
      }

      try {
        await this.deps.setDeviceTarget(deviceId, targetCap, targetTemp);
        this.deps.log(`Price optimization: Set ${device.name} to ${targetTemp}°C (${priceStateStr} hour, delta ${deltaInfo}, base ${baseTemp}°C, ${priceInfo})`);
        this.deps.updateLocalSnapshot(deviceId, { target: targetTemp });
      } catch (error) {
        this.deps.error(`Price optimization: Failed to set ${device.name} to ${targetTemp}°C`, error);
      }
    }
  }

  async start(): Promise<void> {
    await this.applyOnce();
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
