import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { getRawDevice } from './transport/managerHomeyApi';

type RawHomeyManagerDevice = {
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
  // `Number.isFinite` (not a bare `typeof`) so a non-finite `loadKw` is dropped at
  // the boundary: a raw `Infinity` would pass `snapshotLoad > 0` and propagate.
  if (typeof snapshotLoad === 'number' && Number.isFinite(snapshotLoad) && snapshotLoad > 0) {
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
    const device = await getRawDevice(deviceId) as RawHomeyManagerDevice;
    const load = device?.settings?.load;
    // Drop a non-finite or non-positive settings-sourced load at the boundary (a
    // raw `Infinity` would propagate as an infinite estimate; a `<= 0` load is not
    // a valid estimate) — consistent with `getSnapshotLoad` / `getLoadSettingWatts`.
    if (typeof load === 'number' && Number.isFinite(load) && load > 0) {
      return load;
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
