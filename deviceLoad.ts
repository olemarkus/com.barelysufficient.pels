import type { TargetDeviceSnapshot } from './types';

type HomeyApiLike = {
  devices?: {
    getDevices?: () => Promise<unknown>;
  };
};

type DeviceSettings = { load?: number };
type DeviceInfo = {
  id?: string;
  data?: { id?: string };
  settings?: DeviceSettings;
};

export async function getDeviceLoadSetting(params: {
  deviceId: string;
  snapshot: TargetDeviceSnapshot[];
  getHomeyApi: () => HomeyApiLike | undefined;
  initHomeyApi: () => Promise<void>;
  error: (...args: unknown[]) => void;
}): Promise<number | null> {
  const { deviceId, snapshot, getHomeyApi, initHomeyApi, error } = params;
  const snapshotLoad = getSnapshotLoad(deviceId, snapshot);
  if (snapshotLoad !== null) return snapshotLoad;
  return getApiLoad({ deviceId, getHomeyApi, initHomeyApi, error });
}

function normalizeDeviceList(devices: unknown): DeviceInfo[] {
  if (Array.isArray(devices)) return devices as DeviceInfo[];
  if (devices && typeof devices === 'object') {
    return Object.values(devices as Record<string, DeviceInfo>);
  }
  return [];
}

function getSnapshotLoad(deviceId: string, snapshot: TargetDeviceSnapshot[]): number | null {
  const snapshotLoad = snapshot.find((d) => d.id === deviceId)?.loadKw;
  if (typeof snapshotLoad === 'number' && snapshotLoad > 0) {
    return snapshotLoad * 1000;
  }
  return null;
}

async function getApiLoad(params: {
  deviceId: string;
  getHomeyApi: () => HomeyApiLike | undefined;
  initHomeyApi: () => Promise<void>;
  error: (...args: unknown[]) => void;
}): Promise<number | null> {
  const { deviceId, getHomeyApi, initHomeyApi, error } = params;
  try {
    const homeyApi = await ensureHomeyApi(getHomeyApi, initHomeyApi, error);
    if (!homeyApi?.devices?.getDevices) return null;
    const devices = await homeyApi.devices.getDevices();
    const list = normalizeDeviceList(devices);
    const device = list.find((d) => d.id === deviceId || d.data?.id === deviceId);
    if (device && typeof device.settings?.load === 'number') {
      return device.settings.load;
    }
  } catch (errorValue) {
    const errObj = errorValue as { status?: number; response?: { status?: number } };
    const maybeStatus = errObj?.status ?? errObj?.response?.status;
    error(
      'Failed to read device via manager/devices for load:',
      (errorValue as Error)?.message || errorValue,
      maybeStatus ? `(status ${maybeStatus})` : '',
    );
  }
  return null;
}

async function ensureHomeyApi(
  getHomeyApi: () => HomeyApiLike | undefined,
  initHomeyApi: () => Promise<void>,
  error: (...args: unknown[]) => void,
): Promise<HomeyApiLike | undefined> {
  let homeyApi = getHomeyApi();
  if (homeyApi?.devices?.getDevices) return homeyApi;
  error('HomeyAPI not ready for load lookup, retrying init');
  await initHomeyApi();
  homeyApi = getHomeyApi();
  if (!homeyApi?.devices?.getDevices) {
    error('HomeyAPI still not ready for load lookup; skipping load lookup');
  }
  return homeyApi;
}
