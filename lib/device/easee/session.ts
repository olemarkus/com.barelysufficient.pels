import type { AdapterControlTarget, DeviceAdapterSession } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { toCapabilityTimestampMs } from '../managerControl';
import { isEaseeChargerDevice } from './current';
import { EASEE_CHARGER_STATUS, easeeChargingState, isEaseeChargingStatus,
  type EaseeChargingStatus } from './chargingState';

type StatusAuthority =
  | { kind: 'observed'; status: EaseeChargingStatus; atMs: number; readAtMs: number }
  | { kind: 'retired'; readAtMs: number };

/** Trusted mode observations, owned by this transport rather than a global adapter. */
export class EaseeChargingSession implements DeviceAdapterSession {
  private readonly statuses = new Map<string, StatusAuthority>();

  observeDevice(device: HomeyDeviceLike, readAtMs: number): void {
    const previous = this.statuses.get(device.id);
    if (previous?.kind === 'retired' && readAtMs < previous.readAtMs) return;
    if (!isEaseeChargerDevice(device) || !device.capabilities?.includes(EASEE_CHARGER_STATUS)) {
      if (previous && readAtMs < previous.readAtMs) return;
      // Rejected observations retain their accepted status at the read boundary.
      // A status actually removed from the inventory relinquishes its authority.
      // Keep the accepted descriptor's ordering fence until inventory removal,
      // so an older delayed read cannot reclaim the capability it just retired.
      if (previous) this.statuses.set(device.id, { kind: 'retired', readAtMs });
      return;
    }
    this.observeStatus(device, readAtMs);
  }

  private observeStatus(device: HomeyDeviceLike, readAtMs: number): void {
    const previous = this.statuses.get(device.id);
    const status = device.capabilitiesObj?.[EASEE_CHARGER_STATUS];
    const atMs = toCapabilityTimestampMs(status?.lastUpdated);
    if (!isEaseeChargingStatus(status?.value) || atMs === undefined) return;
    if (previous?.kind === 'observed' && atMs < previous.atMs) return;
    this.statuses.set(device.id, { kind: 'observed', status: status.value, atMs,
      readAtMs: Math.max(readAtMs, previous?.readAtMs ?? readAtMs) });
  }

  observeCapability(deviceId: string, capabilityId: string, value: unknown): void {
    if (this.statuses.get(deviceId)?.kind !== 'observed'
      || capabilityId !== EASEE_CHARGER_STATUS || !isEaseeChargingStatus(value)) return;
    const atMs = Date.now();
    this.statuses.set(deviceId, { kind: 'observed', status: value, atMs, readAtMs: atMs });
  }

  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    const ids = new Set(devices.map(device => device.id));
    for (const id of this.statuses.keys()) if (!ids.has(id)) this.statuses.delete(id);
  }

  withheldCapabilities(): readonly string[] { return []; }
  setTrustEpoch(): void {}
  observedIds(): string[] { return []; }
  observes(): boolean { return false; }
  controls(snapshot: AdapterControlTarget): boolean { return this.statuses.get(snapshot.id)?.kind === 'observed'; }
  project(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot { return snapshot; }
  assertAllowed(): void {}
  hasCarStopEvidence(deviceId: string): boolean {
    const authority = this.statuses.get(deviceId);
    return authority?.kind === 'observed' && authority.status === 'Completed';
  }

  controlEvents(_deviceId: string, capabilityId: string, value: unknown) {
    // The app publishes charger_status, charging, then its lossy standard state.
    // Only the dated status is authoritative, so its duplicate must not undo it.
    if (capabilityId === 'evcharger_charging_state') return [];
    if (capabilityId === EASEE_CHARGER_STATUS) {
      return isEaseeChargingStatus(value)
        ? [{ capabilityId: 'evcharger_charging_state', value: easeeChargingState(value) }]
        : [];
    }
    return [{ capabilityId, value }];
  }
}
