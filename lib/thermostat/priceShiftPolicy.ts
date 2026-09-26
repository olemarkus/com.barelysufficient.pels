import type { SettingsPort } from '../ports/homeyRuntime';
import type { ManualTemperaturePriceShiftPolicy } from '../ports/temperaturePriceShiftPolicy';
import { PER_DEVICE_THERMOSTAT_PRICE_SHIFT_CANCELLATION_KEY_PREFIX } from '../utils/settingsKeys';
import { PriceLevel } from '../price/priceLevels';
import { resolvePriceOptimizationConfig, type PriceOptimizationSettings } from '../price/priceOptimizer';
import type { ThermalDirection } from '../../packages/contracts/src/types';
import { getLogger } from '../logging/logger';
import { applyPriceShift } from './priceShift';

type CancellablePriceLevel = PriceLevel.CHEAP | PriceLevel.EXPENSIVE;
type CancellationRead =
  | { state: 'unavailable' }
  | { state: 'resolved'; cancelledAt: CancellablePriceLevel | null };

function isCancellablePriceLevel(value: unknown): value is CancellablePriceLevel {
  return value === PriceLevel.CHEAP || value === PriceLevel.EXPENSIVE;
}

const perDeviceKey = (deviceId: string): string => (
  `${PER_DEVICE_THERMOSTAT_PRICE_SHIFT_CANCELLATION_KEY_PREFIX}${deviceId}`
);

/**
 * Owns per-device cancellation of a price shift after a manual setpoint edit.
 * Each device's cancelled level has its own settings key; a known change to
 * another price level clears that key. It also authorizes the exact shifted
 * target for the saved mode target, preserving the live write fence.
 */
export class TemperaturePriceShiftPolicy implements ManualTemperaturePriceShiftPolicy {
  constructor(
    private readonly settings: SettingsPort,
    private readonly getCurrentPriceLevel: () => PriceLevel,
    private readonly getPriceOptimizationEnabled: () => boolean,
    private readonly getPriceOptimizationSettings: () => Readonly<Record<string, PriceOptimizationSettings>>,
    private readonly getThermalDirection: (deviceId: string) => ThermalDirection,
    private readonly normalizeTarget: (deviceId: string, value: number) => number,
  ) {}

  /** Whether a saved hold requires observing the price level even while shifts are disabled. */
  hasPendingCancellations(deviceIds: readonly string[]): boolean {
    if (deviceIds.length === 0) return false;
    try {
      const keys = this.settings.getKeys();
      if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => typeof key === 'string')) return true;
      return deviceIds.some((deviceId) => keys.includes(perDeviceKey(deviceId)));
    } catch {
      // An unreadable list might contain a hold, so keep observing the level.
      return true;
    }
  }

  /** Mark the active cheap/expensive shift as canceled for this device. */
  cancelCurrentPriceShift(deviceId: string): boolean {
    if (!deviceId) return false;
    try {
      if (!this.getPriceOptimizationEnabled()
        || !resolvePriceOptimizationConfig(this.getPriceOptimizationSettings(), deviceId).enabled) return true;
      const level = this.getCurrentPriceLevel();
      if (level === PriceLevel.UNKNOWN) return true;
      const key = perDeviceKey(deviceId);
      if (level === PriceLevel.NORMAL) return this.unset(key);
      if (!isCancellablePriceLevel(level)) return true;
      return this.set(key, level);
    } catch {
      return false;
    }
  }

  /** Whether this plan may apply the device's configured shift at this level. */
  shouldApplyPriceShift(deviceId: string, level: PriceLevel): boolean {
    const read = this.read(deviceId);
    if (read.state !== 'resolved') return false;
    const cancelledAt = read.cancelledAt;
    if (cancelledAt === null) return true;
    // An unknown price read is not evidence that the canceled price period ended.
    if (level === PriceLevel.UNKNOWN || level === cancelledAt) return false;
    // A new known level ends the hold. The new level's own delta can apply now.
    return this.unset(perDeviceKey(deviceId));
  }

  /** Accept the current calculated shift while rejecting stale shifted writes. */
  allowsCurrentPriceShiftTarget(deviceId: string, modeTargetC: number, candidateC: number): boolean {
    try {
      if (!this.getPriceOptimizationEnabled()) return false;
      const config = resolvePriceOptimizationConfig(this.getPriceOptimizationSettings(), deviceId);
      if (!config.enabled) return false;
      const level = this.getCurrentPriceLevel();
      if (!this.shouldApplyPriceShift(deviceId, level)) return false;
      const shifted = applyPriceShift(modeTargetC, config, level, this.getThermalDirection(deviceId));
      return this.normalizeTarget(deviceId, shifted) === candidateC;
    } catch {
      // An uncertain current price target must not pass the live write fence.
      return false;
    }
  }

  private read(deviceId: string): CancellationRead {
    const key = perDeviceKey(deviceId);
    let value: unknown;
    try {
      value = this.settings.get(key);
      if (isCancellablePriceLevel(value)) return { state: 'resolved', cancelledAt: value };
      if (value !== null && value !== undefined) return { state: 'unavailable' };
      const keys = this.settings.getKeys();
      if (!Array.isArray(keys) || keys.length === 0 || !keys.every((entry) => typeof entry === 'string')) {
        return { state: 'unavailable' };
      }
      return keys.includes(key)
        ? { state: 'unavailable' }
        : { state: 'resolved', cancelledAt: null };
    } catch {
      return { state: 'unavailable' };
    }
  }

  private set(key: string, value: CancellablePriceLevel): boolean {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.settings.set(key, value);
        return true;
      } catch {
        // A settings write may fail transiently under contention; retry briefly.
      }
    }
    getLogger('thermostat/price-shift').error({ event: 'price_shift_cancellation_persist_failed', key });
    return false;
  }

  private unset(key: string): boolean {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.settings.unset(key);
        return true;
      } catch {
        // Keep the hold active until its persisted key can be removed.
      }
    }
    getLogger('thermostat/price-shift').error({ event: 'price_shift_cancellation_clear_failed', key });
    return false;
  }
}
