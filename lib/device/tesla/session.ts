import type { ChargingCurrentSetup } from '../../../packages/contracts/src/chargingControl';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { DeviceAdapterSession, AdapterControlTarget } from '../deviceAdapter';
import {
  acknowledgedTeslaCurrent, hasTeslaChargingSurface, confirmedTeslaCurrent, isTeslaChargingState,
} from './charging';
import { ACKNOWLEDGED_CURRENT_CAPABILITY_ID } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { toCapabilityTimestampMs } from '../managerControl';
import { isTeslaChargingDevice, teslaDriver } from './identity';

import { hasTeslaHomeEvidence, type HomeLocation } from './evidence';
const NUMERIC_OBSERVATIONS = new Set([
  'measure_location_latitude', 'measure_location_longitude', 'measure_car_drive_speed',
  'measure_charge_current_max', 'measure_charge_current', 'measure_charge_power', 'measure_charge_power_dc',
]);
const TEXT_OBSERVATIONS = new Set(['charging_port_cable', 'car_shift_state', 'car_state']);
function isObservationValue(id: string, value: unknown): boolean {
  if (id === 'charging_state') return isTeslaChargingState(value);
  if (NUMERIC_OBSERVATIONS.has(id)) return typeof value === 'number' && Number.isFinite(value);
  if (TEXT_OBSERVATIONS.has(id)) return typeof value === 'string';
  return id === 'charging_on' && typeof value === 'boolean';
}

/**
 * Home authorization holds while the vehicle's current observations show a
 * stationary AC session at home. A parked car's coordinates stay unchanged, so
 * their age is no evidence: only a contrary observation revokes it.
 */
export class TeslaChargingSession implements DeviceAdapterSession {
  private readonly devices = new Map<string, HomeyDeviceLike>();
  private trustEpoch = '';

  constructor(private readonly home: HomeLocation) {}

  controls(snapshot: AdapterControlTarget): boolean { return hasTeslaChargingSurface(snapshot); }
  hasCarStopEvidence(): boolean { return false; }

  assertAllowed(device: HomeyDeviceLike, setup: ChargingCurrentSetup, connected: boolean): void {
    if (!isTeslaChargingDevice(device)) return;
    if (!connected) throw new Error('Tesla charging requires a connected Homey device feed.');
    if (setup.confirmation !== 'vehicle' || !this.isAllowed(device.id)) {
      throw new Error('Tesla charging requires a confirmed stationary AC charging session at home.');
    }
  }

  project(snapshot: TransportDeviceSnapshot, setup: ChargingCurrentSetup): TransportDeviceSnapshot {
    if (setup.confirmation === 'vehicle' && this.isAllowed(snapshot.id)) return snapshot;
    // A connected vehicle outside the accepted home session contributes no home charging power.
    return { ...snapshot, available: false, measuredPowerKw: 0 };
  }

  controlEvents(deviceId: string, capabilityId: string, value: unknown) {
    // The same vendor enum governs full reads, session evidence and emitted
    // feedback. A rejected state must not republish an old current observation.
    if (capabilityId === 'charging_state' && !isTeslaChargingState(value)) return [];
    const localValue = capabilityId === 'measure_charge_power' && !this.isAllowed(deviceId) ? 0 : value;
    const events = [{ capabilityId, value: localValue }];
    if (['measure_charge_current', 'measure_charge_current_max',
      'measure_charge_power', 'charging_on', 'charging_state']
      .includes(capabilityId)) {
      const current = this.confirmedCurrent(deviceId);
      if (current !== undefined) events.push({ capabilityId: 'available_installation_current', value: current });
    }
    // The limit echo acknowledges a command at once; it is published apart from
    // the confirmed current, which still waits for fresh actual measurements.
    if (capabilityId === 'measure_charge_current_max') {
      const acknowledged = this.acknowledgedCurrent(deviceId);
      if (acknowledged !== undefined) {
        events.push({ capabilityId: ACKNOWLEDGED_CURRENT_CAPABILITY_ID, value: acknowledged });
      }
    }
    return events;
  }

  observeDevices(devices: readonly HomeyDeviceLike[]): void {
    for (const device of devices) this.observeDevice(device);
  }

  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    const ids = new Set(devices.map((device) => device.id));
    for (const id of this.devices.keys()) if (!ids.has(id)) this.devices.delete(id);
  }

  observeDevice(device: HomeyDeviceLike): void {
    if (teslaDriver(device) === undefined) return;
    const previous = this.devices.get(device.id);
    const capabilities = mergeCapabilities(previous, device);
    this.devices.set(device.id, { ...device, capabilitiesObj: capabilities });
  }

  observeCapability(deviceId: string, capabilityId: string, value: unknown): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const previous = device.capabilitiesObj[capabilityId];
    if (!isObservationValue(capabilityId, value)) return;
    this.observeDevice({ ...device, capabilitiesObj: {
      ...device.capabilitiesObj, [capabilityId]: { ...previous, value, lastUpdated: new Date().toISOString() },
    } });
  }

  confirmedCurrent(deviceId: string): number | undefined {
    const raw = this.devices.get(deviceId);
    return raw && isTeslaChargingDevice(raw)
      ? confirmedTeslaCurrent(raw.capabilitiesObj)?.value as number | undefined : undefined;
  }

  acknowledgedCurrent(deviceId: string): number | undefined {
    const raw = this.devices.get(deviceId);
    return raw && isTeslaChargingDevice(raw)
      ? acknowledgedTeslaCurrent(raw.capabilitiesObj)?.value as number | undefined : undefined;
  }

  observedIds(): string[] { return [...this.devices.keys()]; }

  withheldCapabilities(): readonly string[] { return []; }

  observes(deviceId: string): boolean { return this.devices.has(deviceId); }

  /** A trust gap discards what the feed reported before it; the next full read re-establishes it. */
  setTrustEpoch(epoch: string): void {
    if (epoch === this.trustEpoch) return;
    this.trustEpoch = epoch;
    this.devices.clear();
  }

  isAllowed(deviceId: string): boolean {
    const battery = this.devices.get(deviceId);
    if (!battery || !isTeslaChargingDevice(battery)) return false;
    // Away coordinates, motion, a disconnect or an unavailable companion fail this at once.
    return hasTeslaHomeEvidence(battery, [...this.devices.values()], this.home);
  }
}

function mergeCapabilities(previous: HomeyDeviceLike | undefined, device: HomeyDeviceLike) {
  const accepted = Object.entries(device.capabilitiesObj).filter(([id, capability]) => {
    const time = toCapabilityTimestampMs(capability?.lastUpdated);
    const priorTime = toCapabilityTimestampMs(previous?.capabilitiesObj[id]?.lastUpdated);
    if (!capability || time === undefined || (priorTime !== undefined && time < priorTime)) return false;
    return isObservationValue(id, capability.value);
  });
  return { ...previous?.capabilitiesObj, ...Object.fromEntries(accepted) };
}
