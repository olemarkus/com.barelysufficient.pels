import type Homey from 'homey';
import type { HomeyDeviceLike } from '../utils/types';
import type { HomeyEnergyApi } from '../utils/homeyEnergy';

export type HomeyApiDevicesClient = {
  getDevices?: () => Promise<Record<string, HomeyDeviceLike> | HomeyDeviceLike[]>;
  setCapabilityValue?: (args: { deviceId: string; capabilityId: string; value: unknown }) => Promise<void>;
  getDevice?: (args: { id: string }) => Promise<unknown>;
  getDeviceSettingsObj?: (args: { id: string }) => Promise<unknown>;
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  on?: (event: string, listener: (payload: HomeyDeviceLike) => void) => unknown;
  off?: (event: string, listener: (payload: HomeyDeviceLike) => void) => unknown;
};

export type HomeyApiClient = {
  devices?: HomeyApiDevicesClient;
  energy?: HomeyEnergyApi;
};

export type HomeyApiConstructor = {
  createAppAPI: (opts: {
    homey: Homey.App['homey'];
    debug?: ((...args: unknown[]) => void) | null;
  }) => Promise<HomeyApiClient>;
};
