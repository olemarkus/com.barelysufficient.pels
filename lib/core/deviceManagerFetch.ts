import type { HomeyDeviceLike, Logger } from '../utils/types';
import { isHomeyDeviceLike } from '../utils/types';
import {
  extractLiveHomePowerWatts,
  extractLivePowerWattsByDeviceId,
  type LiveDevicePowerWatts,
} from './deviceManagerEnergy';
import {
  DEVICES_API_PATH,
  getEnergyLiveReport,
  getRawDevice,
  getRawDevices,
  logDeviceManagerRuntimeError,
} from './deviceManagerHomeyApi';

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
      const rawList = Array.isArray(devices) ? devices : Object.values(devices || {});
      const list = rawList.filter(isHomeyDeviceLike);
      logger.debug(
        `Manager API returned ${list.length} devices`
        + (rawList.length === list.length ? '' : ` (${rawList.length - list.length} invalid entries ignored)`),
      );
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
      if (isHomeyDeviceLike(result.value)) {
        devices.push(result.value);
      } else {
        failedIds.push(deviceIds[i]);
        logger.debug(`Targeted device fetch returned invalid payload for ${deviceIds[i]}`);
      }
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

export type LivePowerReport = {
  byDeviceId: LiveDevicePowerWatts;
  homePowerW: number | null;
};

export async function fetchLivePowerReport(params: {
  logger: Logger;
}): Promise<LivePowerReport> {
  const { logger } = params;
  try {
    const report = await getEnergyLiveReport();
    if (report === null) {
      logger.error('Energy live report unavailable: REST client not initialized');
      return { byDeviceId: {}, homePowerW: null };
    }
    const byDeviceId = extractLivePowerWattsByDeviceId(report);
    const homePowerW = extractLiveHomePowerWatts(report);
    logger.debug(`Energy live report: homePowerW=${homePowerW}, devices=${Object.keys(byDeviceId).length}`);
    return { byDeviceId, homePowerW };
  } catch (error) {
    logDeviceManagerRuntimeError(logger, 'Energy live report fetch failed', error);
    return { byDeviceId: {}, homePowerW: null };
  }
}
