import { confirmedTeslaCurrent } from './teslaChargingWiring';
import type { HomeyDeviceLike } from '../utils/types';
import { toCapabilityTimestampMs } from './managerControl';
import { isTeslaChargingDevice } from './chargingCurrentAdapter';

import { readTeslaHomeEvidence, type HomeLocation, type HomeSessionIdentity } from './teslaChargingEvidence';
export type { HomeLocation } from './teslaChargingEvidence';
type HomeSession = { id: number; identity: HomeSessionIdentity };
const FRESH_LOCATION_MS = 10 * 60_000;
const NUMERIC_OBSERVATIONS = new Set([
  'measure_location_latitude', 'measure_location_longitude', 'measure_car_drive_speed',
  'measure_charge_current_max', 'measure_charge_current', 'measure_charge_power', 'measure_charge_power_dc',
]);
const TEXT_OBSERVATIONS = new Set(['charging_state', 'charging_port_cable', 'car_shift_state', 'car_state']);
function isObservationValue(id: string, value: unknown): boolean {
  if (NUMERIC_OBSERVATIONS.has(id)) return typeof value === 'number' && Number.isFinite(value);
  if (TEXT_OBSERVATIONS.has(id)) return typeof value === 'string';
  return id === 'charging_on' && typeof value === 'boolean';
}

/** Home authorization belongs to one uninterrupted, stationary AC session. */
export class TeslaChargingSession {
  private readonly devices = new Map<string, HomeyDeviceLike>();
  private readonly sessions = new Map<string, HomeSession>();
  private nextSessionId = 1;
  private trustEpoch = '';
  private freshAfterMs = Date.now() - FRESH_LOCATION_MS;
  private readonly disconnectedAt = new Map<string, number>();

  constructor(private readonly home: HomeLocation) {}

  observeDevices(devices: readonly HomeyDeviceLike[]): void {
    for (const device of devices) this.observeDevice(device);
  }

  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    const ids = new Set(devices.map((device) => device.id));
    for (const id of this.devices.keys()) if (!ids.has(id)) this.devices.delete(id);
    for (const id of this.sessions.keys()) this.isAllowed(id);
  }

  observeDevice(device: HomeyDeviceLike): void {
    if (!device.driverId?.startsWith('homey:app:com.tesla.car:')) return;
    const previous = this.devices.get(device.id);
    const capabilities = mergeCapabilities(previous, device);
    if (isTeslaChargingDevice(device) && capabilities.charging_state?.value === 'Disconnected'
      && previous?.capabilitiesObj?.charging_state?.value !== 'Disconnected') {
      this.disconnectedAt.set(device.id, toCapabilityTimestampMs(capabilities.charging_state.lastUpdated)!);
    }
    this.devices.set(device.id, { ...device, capabilitiesObj: capabilities });
    // Any affirmative away, motion or disconnect ends authorization immediately.
    for (const id of this.sessions.keys()) this.isAllowed(id);
  }

  observeCapability(deviceId: string, capabilityId: string, value: unknown): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const previous = device.capabilitiesObj?.[capabilityId];
    if (!isObservationValue(capabilityId, value)) return;
    this.observeDevice({ ...device, capabilitiesObj: {
      ...device.capabilitiesObj, [capabilityId]: { ...previous, value, lastUpdated: new Date().toISOString() },
    } });
  }

  confirmedCurrent(deviceId: string): number | undefined {
    const raw = this.devices.get(deviceId);
    return raw && isTeslaChargingDevice(raw)
      ? confirmedTeslaCurrent(raw.capabilitiesObj ?? {})?.value as number | undefined : undefined;
  }

  observedIds(): string[] { return [...this.devices.keys()]; }

  sessionId(deviceId: string): number {
    return this.isAllowed(deviceId) ? this.sessions.get(deviceId)!.id : 0;
  }

  observes(deviceId: string): boolean { return this.devices.has(deviceId); }

  /** A reconnect requires location evidence obtained after that trust gap. */
  setTrustEpoch(epoch: string): void {
    if (epoch === this.trustEpoch) return;
    const initial = this.trustEpoch === '';
    this.trustEpoch = epoch;
    if (!initial) this.freshAfterMs = Date.now();
    this.sessions.clear();
    this.devices.clear();
  }

  isAllowed(deviceId: string): boolean {
    const battery = this.devices.get(deviceId);
    if (!battery || !isTeslaChargingDevice(battery)) return false;
    const evidence = readTeslaHomeEvidence(battery, [...this.devices.values()], this.home);
    if (!evidence) {
      if (this.sessions.delete(deviceId)) this.disconnectedAt.set(deviceId, Date.now());
      return false;
    }
    const session = this.sessions.get(deviceId);
    const { identity, coordinateAtMs } = evidence;
    if (session && session.identity.vehicleId === identity.vehicleId
      && session.identity.locationId === identity.locationId && session.identity.carId === identity.carId) return true;
    const now = Date.now();
    const notBefore = Math.max(this.freshAfterMs, this.disconnectedAt.get(deviceId) ?? 0, now - FRESH_LOCATION_MS);
    if (coordinateAtMs > now || coordinateAtMs < notBefore) {
      this.sessions.delete(deviceId);
      return false;
    }
    this.sessions.set(deviceId, { id: this.nextSessionId++, identity });
    return true;
  }
}

function mergeCapabilities(previous: HomeyDeviceLike | undefined, device: HomeyDeviceLike) {
  const accepted = Object.entries(device.capabilitiesObj ?? {}).filter(([id, capability]) => {
    const time = toCapabilityTimestampMs(capability?.lastUpdated);
    const priorTime = toCapabilityTimestampMs(previous?.capabilitiesObj?.[id]?.lastUpdated);
    if (!capability || time === undefined || (priorTime !== undefined && time < priorTime)) return false;
    return isObservationValue(id, capability.value);
  });
  return { ...previous?.capabilitiesObj, ...Object.fromEntries(accepted) };
}
