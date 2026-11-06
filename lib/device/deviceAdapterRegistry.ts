import type { ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import type { HubHomeLocation } from './hubHomeLocation';
import { teslaAdapter } from './tesla';
import { easeeAdapter } from './easee';
import { enuaAdapter } from './enua';
import { alfenAdapter } from './alfen';
import { alfenProlineAdapter } from './alfenProline';
import { peblarAdapter } from './peblar';
import { zappiAdapter } from './myenergi';
import { wallboxAdapter } from './wallbox';
import { zaptecAdapter } from './zaptec';
import { futurehomeAdapter } from './futurehome';
import { smaAdapter } from './sma';
import { osoAdapter } from './oso';
import { knxAdapter } from './knx';
import { sessyAdapter } from './sessy';
import { ankerSolixAdapter } from './anker';
import { zinvoltAdapter } from './zinvolt';
import { marstekConnectorAdapter } from './marstek';
import { sigenergyAdapter } from './sigenergy';
import { zendureLocalAdapter } from './zendure';
import { huaweiLuna2000Adapter } from './huawei';
import { plainDeviceAdapter } from './standardDeviceAdapter';
import type { DeviceAdapter, AdapterObservation, AdapterControlTarget, DeviceAdapterSession } from './deviceAdapter';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../utils/types';

const adapters: readonly DeviceAdapter[] = [
  teslaAdapter, easeeAdapter, enuaAdapter, alfenAdapter, alfenProlineAdapter, peblarAdapter, zappiAdapter,
  wallboxAdapter, zaptecAdapter, futurehomeAdapter, osoAdapter, smaAdapter, knxAdapter,
  sessyAdapter, ankerSolixAdapter, zinvoltAdapter, marstekConnectorAdapter, sigenergyAdapter, zendureLocalAdapter,
  huaweiLuna2000Adapter,
];

export function getDeviceAdapter(device: HomeyDeviceLike): DeviceAdapter {
  return adapters.find((adapter) => adapter.matches(device)) ?? plainDeviceAdapter;
}
export function getCapabilityAdapter(capabilities: readonly string[]): DeviceAdapter {
  return adapters.find((adapter) => adapter.matchesCapabilities(capabilities)) ?? plainDeviceAdapter;
}
export function getSnapshotAdapter(snapshot: AdapterObservation): DeviceAdapter {
  return getCapabilityAdapter(snapshot.capabilities ?? []);
}

/** Runtime-owned instances: no session state is shared between transports. */
export class DeviceAdapterSessions {
  private readonly sessions: readonly DeviceAdapterSession[];
  constructor(home: HubHomeLocation) { this.sessions = adapters.map((adapter) => adapter.createSession(home)); }
  observeDevices(devices: readonly HomeyDeviceLike[], readAtMs: number): void {
    for (const device of devices) this.observeDevice(device, readAtMs);
  }
  observeDevice(device: HomeyDeviceLike, readAtMs: number): void {
    for (const session of this.sessions) session.observeDevice(device, readAtMs);
  }
  observeCapability(id: string, capability: string, value: unknown): void {
    for (const session of this.sessions) session.observeCapability(id, capability, value);
  }
  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    for (const session of this.sessions) session.retainDevices(devices);
  }
  /** `device` as it is parsed: without the capabilities a session withholds from it. */
  withholdCapabilities(device: HomeyDeviceLike): HomeyDeviceLike {
    const withheld = new Set(this.sessions.flatMap((session) => session.withheldCapabilities(device)));
    if (withheld.size === 0) return device;
    return {
      ...device,
      capabilities: (device.capabilities ?? []).filter((capabilityId) => !withheld.has(capabilityId)),
      capabilitiesObj: Object.fromEntries(Object.entries(device.capabilitiesObj ?? {})
        .filter(([capabilityId]) => !withheld.has(capabilityId))),
    };
  }
  setTrustEpoch(epoch: string): void { for (const session of this.sessions) session.setTrustEpoch(epoch); }
  observedIds(): string[] { return this.sessions.flatMap((session) => session.observedIds()); }
  observes(id: string): boolean { return this.sessions.some((session) => session.observes(id)); }
  hasCarStopEvidence(id: string): boolean { return this.sessions.some(session => session.hasCarStopEvidence(id)); }
  controls(snapshot: AdapterControlTarget): boolean {
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
