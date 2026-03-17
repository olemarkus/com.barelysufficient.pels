import type { TargetDeviceSnapshot } from '../utils/types';
import { DEVICES_API_PATH, getRawDevices } from './deviceManagerHomeyApi';

type DeviceInfo = {
  id?: string;
  data?: { id?: string };
  settings?: { load?: number };
};

export async function getDeviceLoadSetting(params: {
  deviceId: string;
  snapshot: TargetDeviceSnapshot[];
  error: (...args: unknown[]) => void;
}): Promise<number | null> {
  const { deviceId, snapshot, error } = params;
  const snapshotLoad = getSnapshotLoad(deviceId, snapshot);
  if (snapshotLoad !== null) return snapshotLoad;
  return getApiLoad({ deviceId, error });
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
  error: (...args: unknown[]) => void;
}): Promise<number | null> {
  const { deviceId, error } = params;
  try {
    const devices = await getRawDevices(DEVICES_API_PATH);
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

function normalizeDeviceList(devices: unknown): DeviceInfo[] {
  if (Array.isArray(devices)) return devices as DeviceInfo[];
  if (devices && typeof devices === 'object') {
    return Object.values(devices as Record<string, DeviceInfo>);
  }
  return [];
}
