import type Homey from 'homey';
import type { DeviceManager } from '../core/deviceManager';
import { getDateKeyInTimeZone } from '../utils/dateUtils';
import { safeJsonStringify } from '../utils/logUtils';
import {
  resolveHomeyEnergyApiFromHomeyApi,
  resolveHomeyEnergyApiFromSdk,
  type HomeyEnergyApi,
} from '../utils/homeyEnergy';

export async function logDynamicElectricityPricesFromHomey(params: {
  homey: Homey.App['homey'];
  deviceManager?: DeviceManager;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}): Promise<void> {
  const { homey, deviceManager, log, error } = params;
  const sdkEnergy = resolveHomeyEnergyApiFromSdk(homey);
  const homeyApiEnergy = sdkEnergy ? null : resolveHomeyEnergyApiFromHomeyApi(deviceManager?.getHomeyApi?.());
  let fetcher: { api: HomeyEnergyApi; label: string } | null = null;
  if (sdkEnergy) {
    fetcher = { api: sdkEnergy, label: 'Homey SDK' };
  } else if (homeyApiEnergy) {
    fetcher = { api: homeyApiEnergy, label: 'HomeyAPI' };
  }
  if (!fetcher) {
    log('Dynamic electricity prices not available from Homey SDK or HomeyAPI.');
    return;
  }
  try {
    const timeZone = homey.clock.getTimezone();
    const today = getDateKeyInTimeZone(new Date(), timeZone);
    const prices = await fetcher.api.fetchDynamicElectricityPrices({ date: today });
    const count = Array.isArray(prices) ? prices.length : null;
    const sample = Array.isArray(prices) ? prices[0] : prices;
    log('Fetched dynamic electricity prices from Homey.', {
      source: fetcher.label,
      date: today,
      count,
      sample: safeJsonStringify(sample),
    });
  } catch (err) {
    error(`Failed to fetch dynamic electricity prices from ${fetcher.label}.`, err as Error);
  }
}
