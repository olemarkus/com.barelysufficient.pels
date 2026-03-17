import type { HomeyEnergyApi } from '../utils/homeyEnergy';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { extractLivePowerWattsByDeviceId, type LiveDevicePowerWatts } from './deviceManagerEnergy';
import { DEVICES_API_PATH, getRawDevices, logDeviceManagerRuntimeError } from './deviceManagerHomeyApi';

export type DeviceFetchSource = 'raw_manager_devices';

const DEVICE_FETCH_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

export async function fetchDevicesWithFallback(params: {
  logger: Logger;
}): Promise<{
  devices: HomeyDeviceLike[];
  fetchSource: DeviceFetchSource;
}> {
  const { logger } = params;
  let lastError: unknown;
  for (let attempt = 0; attempt <= DEVICE_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const devices = await getRawDevices(DEVICES_API_PATH);
      const list = Array.isArray(devices) ? devices : Object.values(devices || {});
      logger.debug(`Manager API returned ${list.length} devices`);
      return {
        devices: list,
        fetchSource: 'raw_manager_devices',
      };
    } catch (error) {
      lastError = error;
      if (attempt < DEVICE_FETCH_RETRY_DELAYS_MS.length) {
        const delay = DEVICE_FETCH_RETRY_DELAYS_MS[attempt];
        logger.debug(`Device fetch attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await new Promise((resolve) => { setTimeout(resolve, delay); });
      }
    }
  }
  logDeviceManagerRuntimeError(logger, 'Device fetch failed after all retries', lastError);
  throw lastError;
}

export async function fetchLivePowerWattsByDeviceId(params: {
  energyApi?: Pick<HomeyEnergyApi, 'getLiveReport'>;
  logger: Logger;
}): Promise<LiveDevicePowerWatts> {
  const { energyApi, logger } = params;
  if (typeof energyApi?.getLiveReport !== 'function') return {};
  try {
    const liveReport = await energyApi.getLiveReport({});
    return extractLivePowerWattsByDeviceId(liveReport);
  } catch (error) {
    const message = 'Homey energy live report unavailable for device snapshot';
    logDeviceManagerRuntimeError(logger, message, error);
    return {};
  }
}
