/**
 * Transport-owned parsed snapshot and raw-device indexes. Refresh, realtime
 * ingest, and writes share this device truth; refresh lifecycle bookkeeping is
 * owned separately by `SnapshotRefreshState`.
 */
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceId } from './managerHelpers';

export class TransportSnapshotStore {
  private snapshot: TransportDeviceSnapshot[] = [];
  private snapshotByDeviceId = new Map<string, TransportDeviceSnapshot>();
  private readonly trackedRawDeviceById = new Map<string, HomeyDeviceLike>();
  private latestRawDevices: HomeyDeviceLike[] = [];

  getSnapshot(): TransportDeviceSnapshot[] {
    return this.snapshot;
  }

  getSnapshotByDeviceId(deviceId: string): TransportDeviceSnapshot | undefined {
    return this.snapshotByDeviceId.get(deviceId);
  }

  getSnapshotIndex(): ReadonlyMap<string, TransportDeviceSnapshot> {
    return this.snapshotByDeviceId;
  }

  replaceSnapshotEntry(deviceId: string, snapshot: TransportDeviceSnapshot): void {
    const index = this.snapshot.findIndex((entry) => entry.id === deviceId);
    if (index === -1) this.snapshot.push(snapshot);
    else this.snapshot[index] = snapshot;
    this.snapshotByDeviceId.set(deviceId, snapshot);
  }

  removeSnapshotEntry(deviceId: string): void {
    const index = this.snapshot.findIndex((entry) => entry.id === deviceId);
    if (index !== -1) this.snapshot.splice(index, 1);
    this.snapshotByDeviceId.delete(deviceId);
  }

  removeSnapshotAt(index: number, deviceId: string): void {
    this.snapshot.splice(index, 1);
    this.snapshotByDeviceId.delete(deviceId);
  }

  replaceSnapshot(snapshot: TransportDeviceSnapshot[]): void {
    this.snapshot = snapshot;
    this.snapshotByDeviceId = new Map(snapshot.map((device) => [device.id, device]));
  }

  getTrackedRawDevice(deviceId: string): HomeyDeviceLike | undefined {
    return this.trackedRawDeviceById.get(deviceId);
  }

  getTrackedRawDevicesById(): ReadonlyMap<string, HomeyDeviceLike> {
    return this.trackedRawDeviceById;
  }

  clearTrackedRawDevices(): void {
    this.trackedRawDeviceById.clear();
  }

  replaceTrackedRawDevices(devices: readonly HomeyDeviceLike[]): void {
    this.trackedRawDeviceById.clear();
    for (const device of devices) {
      const deviceId = getDeviceId(device);
      if (deviceId !== undefined) this.trackedRawDeviceById.set(deviceId, device);
    }
  }

  trackRawDevice(deviceId: string, device: HomeyDeviceLike): void {
    this.trackedRawDeviceById.set(deviceId, device);
  }

  untrackRawDevice(deviceId: string): void {
    this.trackedRawDeviceById.delete(deviceId);
  }

  getLatestRawDevices(): HomeyDeviceLike[] {
    return this.latestRawDevices;
  }

  replaceLatestRawDevices(devices: HomeyDeviceLike[]): void {
    this.latestRawDevices = devices;
  }

}
