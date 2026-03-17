import type { HomeyEnergyApi } from '../utils/homeyEnergy';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { extractLivePowerWattsByDeviceId, type LiveDevicePowerWatts } from './deviceManagerEnergy';
import { DEVICES_API_PATH, getRawDevice, getRawDevices, logDeviceManagerRuntimeError } from './deviceManagerHomeyApi';

export type DeviceFetchSource = 'raw_manager_devices' | 'targeted_by_id';

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

export async function fetchDevicesByIds(params: {
  deviceIds: string[];
  logger: Logger;
}): Promise<{
  devices: HomeyDeviceLike[];
  fetchSource: DeviceFetchSource;
}> {
  const { deviceIds, logger } = params;
  if (deviceIds.length === 0) {
    return { devices: [], fetchSource: 'targeted_by_id' };
  }
  const results = await Promise.allSettled(
    deviceIds.map((id) => getRawDevice(id)),
  );
  const devices: HomeyDeviceLike[] = [];
  const failedIds: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      devices.push(result.value);
    } else {
      failedIds.push(deviceIds[i]);
      const err = result.reason as Error | undefined;
      logger.debug(
        `Targeted device fetch failed for ${deviceIds[i]}: `
        + `${err?.message || 'unknown error'}`,
      );
    }
  }
  if (failedIds.length > 0) {
    logger.debug(
      `Targeted fetch had ${failedIds.length} failures, `
      + 'falling back to full device fetch',
    );
    return fetchDevicesWithFallback({ logger });
  }
  return { devices, fetchSource: 'targeted_by_id' };
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
