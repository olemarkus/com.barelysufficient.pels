/**
 * Transport-owned parsed snapshot and raw-device indexes. Refresh, realtime
 * ingest, and writes share this device truth; refresh lifecycle bookkeeping is
 * owned separately by `SnapshotRefreshState`.
 */
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceId } from './managerHelpers';
import { NativeSteppedLoadCommandAdapters } from '../managerNativeSteppedCommand';

export class TransportSnapshotStore {
  private snapshot: TransportDeviceSnapshot[] = [];
  private snapshotByDeviceId = new Map<string, TransportDeviceSnapshot>();
  private readonly trackedRawDeviceById = new Map<string, HomeyDeviceLike>();
  private latestRawDevices: HomeyDeviceLike[] = [];
  private homeyDeviceIds: ReadonlySet<string> | undefined;
  /** The tracked devices' native step channels, built from the raw devices above. */
  readonly nativeSteppedAdapters = new NativeSteppedLoadCommandAdapters();

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

  /**
   * Every device's last accepted raw read: the realtime tracking map's (it
   * holds the newest accepted read of a tracked device, a `device.update`
   * included), else the last full raw list's (every device, managed or not).
   */
  getLastAcceptedRawDevicesById(): ReadonlyMap<string, HomeyDeviceLike> {
    return new Map([
      ...this.latestRawDevices.map((device) => [getDeviceId(device), device] as const),
      ...this.trackedRawDeviceById,
    ]);
  }

  /**
   * Every device in Homey's last full device list, readable or not: the
   * inventory a device is truly gone from. Empty before the first full list.
   */
  getHomeyDeviceIds(): ReadonlySet<string> {
    return this.homeyDeviceIds ?? new Set();
  }

  getDeviceMembership(deviceId: string): 'unknown' | 'present' | 'removed' {
    if (!this.homeyDeviceIds) return 'unknown';
    return this.homeyDeviceIds.has(deviceId) ? 'present' : 'removed';
  }

  getLatestRawDevices(): HomeyDeviceLike[] {
    return this.latestRawDevices;
  }

  /**
   * A full read's accepted raw devices, and Homey's list as fetched for it
   * (every device it named, including one whose read was ignored).
   */
  replaceLatestRawDevices(devices: HomeyDeviceLike[], fetchedList: readonly HomeyDeviceLike[]): void {
    this.latestRawDevices = devices;
    this.homeyDeviceIds = new Set(fetchedList.map(getDeviceId));
  }

}
