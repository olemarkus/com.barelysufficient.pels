import type { AdapterControlTarget, DeviceAdapterSession } from '../deviceAdapter';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { isFuturehomeCharger, readCurrentLimit } from './identity';

type ObservedLimit = { currentA: number | undefined; changedAtMs: number };

/**
 * Dates the charger's current-limit setting. Homey stamps capabilities, not
 * settings, so the limit is dated when an accepted device read first shows a
 * new value. An unchanged value keeps its date: a later read repeating the old
 * limit is not new evidence about a command issued in between.
 */
export class FuturehomeChargerSession implements DeviceAdapterSession {
  private readonly limits = new Map<string, ObservedLimit>();

  observeDevice(device: HomeyDeviceLike): void {
    if (!isFuturehomeCharger(device)) return;
    const currentA = readCurrentLimit(device);
    const previous = this.limits.get(device.id);
    if (previous && previous.currentA === currentA) return;
    this.limits.set(device.id, { currentA, changedAtMs: Date.now() });
  }

  observeCapability(): void {}

  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    const ids = new Set(devices.map((device) => device.id));
    for (const id of this.limits.keys()) if (!ids.has(id)) this.limits.delete(id);
  }

  setTrustEpoch(): void {}
  observedIds(): string[] { return []; }
  observes(): boolean { return false; }
  controls(snapshot: AdapterControlTarget): boolean { return this.limits.has(snapshot.id); }

  /** A Flow report carries its own date and is left as reported. */
  project(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const limit = this.limits.get(snapshot.id);
    if (limit?.currentA === undefined || snapshot.reportedStepId === undefined
      || snapshot.reportedStepObservedAtMs !== undefined) return snapshot;
    return { ...snapshot, reportedStepObservedAtMs: limit.changedAtMs };
  }

  assertAllowed(): void {}
  controlEvents(_deviceId: string, capabilityId: string, value: unknown) { return [{ capabilityId, value }]; }
}
