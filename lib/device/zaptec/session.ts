import type {
  AdapterControlTarget, CapabilityWrite, ChargingInstallationMembership, DeviceAdapterSession, InventoryCompleteness,
} from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { normalizeText } from './charging';
import { ZaptecCarStops } from './carStop';
import { WATT_CONTROL_CAPABILITIES } from '../targetPowerControlClaims';

/**
 * The installation a Zaptec charger is on, by the id the app gives it. A Sense
 * carries the same id but is a meter: it takes no current from the installation.
 */
export function zaptecInstallationOf(device: HomeyDeviceLike): string | undefined {
  const id = device.data.installationId;
  return isZaptecCharger(device) && typeof id === 'string' && id.trim() !== '' ? id : undefined;
}

/** Inventory membership stays stable between complete reads, including when a member is offline. */
export class ZaptecInstallationSession implements DeviceAdapterSession {
  private sharedInstallations: ReadonlyMap<string, readonly string[]> = new Map();

  /**
   * Each shared installation's chargers, from the last full inventory. Its main
   * is the charger with the lowest Zaptec charger id (the app's device data id),
   * which survives a re-pair as a Homey device id does not. Recomputed on every
   * full read, with no failover while the main is offline.
   */
  private installations: ReadonlyMap<string, ChargingInstallationMembership> = new Map();

  /** The Zaptec chargers this transport has read, the only devices a car-stop is recorded for. */
  private readonly chargers = new Set<string>();

  private readonly carStops = new ZaptecCarStops();

  retainDevices(devices: readonly HomeyDeviceLike[], inventory: InventoryCompleteness): void {
    if (inventory !== 'complete') return;
    const ids = new Set(devices.map((device) => device.id));
    this.carStops.retain(ids);
    for (const id of this.chargers) if (!ids.has(id)) this.chargers.delete(id);
    const chargersByInstallation = new Map<string, HomeyDeviceLike[]>();
    for (const device of devices) {
      const installationId = zaptecInstallationOf(device);
      if (installationId === undefined) continue;
      const chargers = chargersByInstallation.get(installationId) ?? [];
      chargers.push(device);
      chargersByInstallation.set(installationId, chargers);
    }
    const installations = new Map<string, ChargingInstallationMembership>();
    for (const [installationId, chargers] of chargersByInstallation) {
      const identified = chargers.flatMap((device) => {
        const id = device.data.id;
        return typeof id === 'string' && id.trim() !== '' ? [{ deviceId: device.id, chargerId: id }] : [];
      });
      if (chargers.length < 2 || identified.length !== chargers.length) continue;
      const ordered = identified.sort((a, b) => compareIds(a.chargerId, b.chargerId));
      const main = ordered[0];
      if (!main) continue;
      installations.set(installationId, {
        id: installationId,
        mainId: main.deviceId,
        memberIds: ordered.map(({ deviceId }) => deviceId),
      });
    }
    this.installations = installations;
    this.sharedInstallations = new Map([...chargersByInstallation]
      .filter(([, chargers]) => chargers.length > 1)
      .map(([installationId, chargers]) => [installationId, chargers.map(({ id }) => id)]));
  }

  chargingInstallationOf(device: HomeyDeviceLike): ChargingInstallationMembership | undefined {
    const installationId = zaptecInstallationOf(device);
    const installation = installationId === undefined ? undefined : this.installations.get(installationId);
    return installation?.memberIds.includes(device.id) ? installation : undefined;
  }

  sharedChargingMemberIds(device: HomeyDeviceLike): readonly string[] | undefined {
    const installationId = zaptecInstallationOf(device);
    return installationId === undefined ? undefined : this.sharedInstallations.get(installationId);
  }

  withheldCapabilities(device: HomeyDeviceLike): readonly string[] {
    if (!this.sharedChargingMemberIds(device)) return [];
    return device.capabilitiesObj.target_power_mode?.value === 'homey' ? [] : WATT_CONTROL_CAPABILITIES;
  }

  observeDevice(device: HomeyDeviceLike): void {
    if (!isZaptecCharger(device)) return;
    this.chargers.add(device.id);
    this.carStops.noteRead(device);
  }

  observeCapability(deviceId: string, capabilityId: string): void {
    this.carStops.noteReport(deviceId, capabilityId);
  }

  observeRefusedWrite(deviceId: string, write: CapabilityWrite, message: string, atMs: number): boolean {
    return this.chargers.has(deviceId) && this.carStops.noteRefused(deviceId, write, message, atMs);
  }

  observeAcceptedWrite(deviceId: string, write: CapabilityWrite): boolean {
    return this.carStops.noteAccepted(deviceId, write);
  }

  setTrustEpoch(): void {}
  observedIds(): string[] { return []; }
  observes(): boolean { return false; }
  /** A charger whose car stopped its session is read through {@link project}. */
  controls(snapshot: AdapterControlTarget): boolean { return this.carStops.has(snapshot.id); }
  missingCompanion(): 'none' { return 'none'; }
  project: DeviceAdapterSession['project'] = (snapshot) => this.carStops.project(snapshot);
  assertAllowed(): void {}
  controlEvents: DeviceAdapterSession['controlEvents'] = (_deviceId, capabilityId, value) => [{ capabilityId, value }];
}

/**
 * The installation's level on the charger's watt ladder. While Homey holds the
 * watt target (`target_power_mode` `homey`) a positive target is the level the
 * app set the installation's current from. Otherwise, and at a 0 W target,
 * which stops only this charger's car, the installation's available current
 * is the level, in watts per amp as the app's watt range gives them: its
 * smallest positive target is 6 A (`excludeMax`). Below 6 A no car charges.
 */
export const zaptecInstallationLevelW = (device: HomeyDeviceLike): number | undefined => {
  const target = device.capabilitiesObj.target_power;
  const mode = device.capabilitiesObj.target_power_mode?.value;
  if (mode === 'homey' && typeof target?.value === 'number' && Number.isFinite(target.value) && target.value > 0) {
    return target.value;
  }
  const current = device.capabilitiesObj.available_installation_current?.value;
  const wattsPerAmp = zaptecInstallationWattsPerAmp(device);
  if (typeof current !== 'number' || !Number.isFinite(current) || wattsPerAmp === undefined) return undefined;
  return current < MIN_CHARGING_CURRENT_A ? 0 : Math.round(current * wattsPerAmp);
};

export const zaptecInstallationWattsPerAmp = (device: HomeyDeviceLike): number | undefined => {
  const minimum = device.capabilitiesObj.target_power?.excludeMax;
  return typeof minimum === 'number' && Number.isFinite(minimum) && minimum > 0
    ? minimum / MIN_CHARGING_CURRENT_A : undefined;
};

const MIN_CHARGING_CURRENT_A = 6;

const compareIds = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

const isZaptecCharger = (device: HomeyDeviceLike): boolean => (
  device.driverId.startsWith('homey:app:com.zaptec:') && normalizeText(device.class) === 'evcharger'
);
