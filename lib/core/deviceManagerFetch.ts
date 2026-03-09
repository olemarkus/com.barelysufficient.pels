import type Homey from 'homey';
import type { HomeyEnergyApi } from '../utils/homeyEnergy';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { extractLivePowerWattsByDeviceId, type LiveDevicePowerWatts } from './deviceManagerEnergy';
import { getRawDevices } from './deviceManagerHomeyApi';
import { syncRealtimeDeviceUpdateListener } from './deviceManagerRuntime';

type DevicesApiLike = {
  getDevices?: () => Promise<Record<string, HomeyDeviceLike> | HomeyDeviceLike[]>;
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  on?: (event: string, listener: (payload: HomeyDeviceLike) => void) => unknown;
  off?: (event: string, listener: (payload: HomeyDeviceLike) => void) => unknown;
};

type EnergyApiLike = Pick<HomeyEnergyApi, 'getLiveReport'>;

export async function fetchDevicesWithFallback(params: {
  devicesApi?: DevicesApiLike;
  homey: Homey.App;
  logger: Logger;
  hasRealtimeDeviceUpdateListener: boolean;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  realtimeDeviceUpdateListener: (device: HomeyDeviceLike) => void;
  realtimeDeviceUpdateEventName: string;
  initRealtimeListeners: (devices: HomeyDeviceLike[]) => Promise<void>;
}): Promise<{
  devices: HomeyDeviceLike[];
  hasRealtimeDeviceUpdateListener: boolean;
}> {
  const {
    devicesApi,
    homey,
    logger,
    hasRealtimeDeviceUpdateListener,
    shouldTrackRealtimeDevice,
    realtimeDeviceUpdateListener,
    realtimeDeviceUpdateEventName,
    initRealtimeListeners,
  } = params;
  if (devicesApi?.getDevices) {
    try {
      const devicesObj = await devicesApi.getDevices();
      const devices = Array.isArray(devicesObj) ? devicesObj : Object.values(devicesObj || {});
      logger.debug(`HomeyAPI returned ${devices.length} devices`);
      const attachedRealtimeDeviceUpdateListener = await syncRealtimeDeviceUpdateListener({
        devicesApi,
        attached: hasRealtimeDeviceUpdateListener,
        devices,
        shouldTrackRealtimeDevice,
        listener: realtimeDeviceUpdateListener,
        eventName: realtimeDeviceUpdateEventName,
        logger,
      });
      await initRealtimeListeners(devices);
      return {
        devices,
        hasRealtimeDeviceUpdateListener: attachedRealtimeDeviceUpdateListener,
      };
    } catch (error) {
      logger.debug('HomeyAPI.getDevices failed, falling back to raw API', error as Error);
    }
  }

  const managerDevices = await tryGetRawDevices({
    homey,
    logger,
    path: 'manager/devices',
    label: 'Manager API returned',
    errorLabel: 'Manager API manager/devices failed, retrying devices',
  });
  if (managerDevices) {
    return {
      devices: managerDevices,
      hasRealtimeDeviceUpdateListener,
    };
  }

  const devices = await tryGetRawDevices({
    homey,
    logger,
    path: 'devices',
    label: 'Manager API devices returned',
    errorLabel: 'Manager API devices failed as well',
  });
  return {
    devices: devices ?? [],
    hasRealtimeDeviceUpdateListener,
  };
}

async function tryGetRawDevices(params: {
  homey: Homey.App;
  logger: Logger;
  path: string;
  label: string;
  errorLabel: string;
}): Promise<HomeyDeviceLike[] | null> {
  const { homey, logger, path, label, errorLabel } = params;
  try {
    const devices = await getRawDevices(homey, path);
    const list = Array.isArray(devices) ? devices : Object.values(devices || {});
    logger.debug(`${label} ${list.length} devices`);
    return list;
  } catch (error) {
    logger.debug(errorLabel, error as Error);
    return null;
  }
}

export async function fetchLivePowerWattsByDeviceId(params: {
  energyApi?: EnergyApiLike;
  logger: Logger;
}): Promise<LiveDevicePowerWatts> {
  const { energyApi, logger } = params;
  if (typeof energyApi?.getLiveReport !== 'function') return {};
  try {
    const liveReport = await energyApi.getLiveReport({});
    return extractLivePowerWattsByDeviceId(liveReport);
  } catch (error) {
    logger.debug('Homey energy live report unavailable for device snapshot', error as Error);
    return {};
  }
}
