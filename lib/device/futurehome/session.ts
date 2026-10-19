import type { AdapterControlTarget, DeviceAdapterSession } from '../deviceAdapter';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { isSteppedLoadSnapshot } from '../../../packages/shared-domain/src/steppedLoadObservedState';
import { isFuturehomeCharger, readCurrentLimit } from './identity';

type ObservedLimit = {
  currentA: number;
  changedAtMs: number;
  // When the read that last showed this value started, so an older read cannot replace it.
  readAtMs: number;
};

// The current the snapshot's reported step stands for.
const reportedCurrentA = (snapshot: TransportDeviceSnapshot): number | undefined => (
  isSteppedLoadSnapshot(snapshot)
    ? snapshot.steppedLoadProfile.steps.find((step) => step.id === snapshot.reportedStepId)?.planningCurrentA
    : undefined
);

/**
 * Dates the charger's current-limit setting. Homey stamps capabilities, not
 * settings, so the limit is dated when an accepted device read first shows a
 * new value. An unchanged value keeps its date: a later read repeating the old
 * limit is not new evidence about a command issued in between. A read that
 * started before the last one observed is older evidence and is ignored: a
 * full refresh fetched before a device update would otherwise bring the old
 * limit back with a fresh date. The date goes only on a step at the current it
 * dates: a parse of a read the session ignored, or of one it never saw (a full
 * refresh observes sessions only while the live feed is trusted), stays
 * undated, and the merge keeps the newer dated step.
 */
export class FuturehomeChargerSession implements DeviceAdapterSession {
  private readonly chargers = new Set<string>();
  private readonly limits = new Map<string, ObservedLimit>();

  observeDevice(device: HomeyDeviceLike, readAtMs: number): void {
    if (!isFuturehomeCharger(device)) return;
    this.chargers.add(device.id);
    const currentA = readCurrentLimit(device);
    // An unreadable value is no observation: the last accepted limit stands.
    if (currentA === undefined) return;
    const previous = this.limits.get(device.id);
    if (previous && readAtMs < previous.readAtMs) return;
    this.limits.set(device.id, previous?.currentA === currentA
      ? { ...previous, readAtMs }
      : { currentA, changedAtMs: Date.now(), readAtMs });
  }

  observeCapability(): void {}

  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    const ids = new Set(devices.map((device) => device.id));
    for (const id of this.chargers) if (!ids.has(id)) this.chargers.delete(id);
    for (const id of this.limits.keys()) if (!ids.has(id)) this.limits.delete(id);
  }

  setTrustEpoch(): void {}
  observedIds(): string[] { return []; }
  observes(): boolean { return false; }
  controls(snapshot: AdapterControlTarget): boolean { return this.chargers.has(snapshot.id); }

  /** A Flow report carries its own date and is left as reported. */
  project(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const limit = this.limits.get(snapshot.id);
    if (!limit || snapshot.reportedStepObservedAtMs !== undefined
      || reportedCurrentA(snapshot) !== limit.currentA) return snapshot;
    return { ...snapshot, reportedStepObservedAtMs: limit.changedAtMs };
  }

  assertAllowed(): void {}
  controlEvents(_deviceId: string, capabilityId: string, value: unknown) { return [{ capabilityId, value }]; }
}
