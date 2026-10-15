import type { ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import type { HubHomeLocation } from './hubHomeLocation';
import { teslaAdapter } from './tesla';
import { easeeAdapter } from './easee';
import { zaptecAdapter } from './zaptec';
import { standardDeviceAdapter } from './standardDeviceAdapter';
import type { DeviceAdapter, AdapterObservation, DeviceAdapterSession } from './deviceAdapter';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../utils/types';

const adapters: readonly DeviceAdapter[] = [teslaAdapter, easeeAdapter, zaptecAdapter];

export function getDeviceAdapter(device: HomeyDeviceLike): DeviceAdapter {
  return adapters.find((adapter) => adapter.matches(device)) ?? standardDeviceAdapter;
}
export function getCapabilityAdapter(capabilities: readonly string[]): DeviceAdapter {
  return adapters.find((adapter) => adapter.matchesCapabilities(capabilities)) ?? standardDeviceAdapter;
}
export function getSnapshotAdapter(snapshot: AdapterObservation): DeviceAdapter {
  return getCapabilityAdapter(snapshot.capabilities ?? []);
}

/** Runtime-owned instances: no session state is shared between transports. */
export class DeviceAdapterSessions {
  private readonly sessions: readonly DeviceAdapterSession[];
  constructor(home: HubHomeLocation) { this.sessions = adapters.map((adapter) => adapter.createSession(home)); }
  observeDevices(devices: readonly HomeyDeviceLike[]): void {
    for (const device of devices) this.observeDevice(device);
  }
  observeDevice(device: HomeyDeviceLike): void { for (const session of this.sessions) session.observeDevice(device); }
  observeCapability(id: string, capability: string, value: unknown): void {
    for (const session of this.sessions) session.observeCapability(id, capability, value);
  }
  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    for (const session of this.sessions) session.retainDevices(devices);
  }
  setTrustEpoch(epoch: string): void { for (const session of this.sessions) session.setTrustEpoch(epoch); }
  observedIds(): string[] { return this.sessions.flatMap((session) => session.observedIds()); }
  observes(id: string): boolean { return this.sessions.some((session) => session.observes(id)); }
  controls(snapshot: AdapterObservation): boolean {
    return this.sessions.some((session) => session.controls(snapshot));
  }
  assertAllowed(device: HomeyDeviceLike, setup: ChargingCurrentSetup, connected: boolean): void {
    for (const session of this.sessions) session.assertAllowed(device, setup, connected);
  }
  project(snapshot: TransportDeviceSnapshot, setup: ChargingCurrentSetup): TransportDeviceSnapshot {
    const session = this.sessions.find((candidate) => candidate.controls(snapshot));
    return session ? session.project(snapshot, setup) : snapshot;
  }
  controlEvents(snapshot: TransportDeviceSnapshot, capabilityId: string, value: unknown) {
    return this.sessions.find((session) => session.controls(snapshot))?.controlEvents(snapshot.id, capabilityId, value)
      ?? [{ capabilityId, value }];
  }
}
