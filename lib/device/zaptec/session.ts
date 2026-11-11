import type { DeviceAdapterSession } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { normalizeText } from './charging';

/**
 * The installation a Zaptec charger is on, by the id the app gives it. A Sense
 * carries the same id but is a meter: it takes no current from the installation.
 */
export const zaptecInstallationOf = (device: HomeyDeviceLike): string | undefined => (
  device.driverId.startsWith('homey:app:com.zaptec:') && normalizeText(device.class) === 'evcharger'
    ? device.data.installationId || undefined
    : undefined
);

/**
 * The installations more than one Zaptec charger shares, from the last full
 * inventory, owned by this transport. The app (1.12) turns a charger's watt
 * target into the installation current, which every charger on the
 * installation then takes, so a charger on a shared one is read without its
 * watt control and behaves as one that has none: no mode takeover and no watt
 * steps, as built-in current control refuses such an installation
 * (`hasSharedChargingInstallation`). A device update keeps the decision the
 * last full inventory made.
 *
 * A charger whose mode already reads `homey` keeps its watt control: PELS
 * claimed it before (or a second charger joined after), and hiding the control
 * would leave the installation at PELS's last watt target with nothing to hand
 * the mode back. It is stepped as before and keeps the shared last-written
 * current until a hand-back exists.
 */
export class ZaptecInstallationSession implements DeviceAdapterSession {
  private sharedInstallations: ReadonlySet<string> = new Set();

  retainDevices(devices: readonly HomeyDeviceLike[]): void {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const device of devices) {
      const installationId = zaptecInstallationOf(device);
      if (installationId === undefined) continue;
      if (seen.has(installationId)) shared.add(installationId);
      seen.add(installationId);
    }
    this.sharedInstallations = shared;
  }

  withheldCapabilities(device: HomeyDeviceLike): readonly string[] {
    const installationId = zaptecInstallationOf(device);
    if (installationId === undefined || !this.sharedInstallations.has(installationId)) return [];
    return device.capabilitiesObj.target_power_mode?.value === 'homey' ? [] : ['target_power', 'target_power_mode'];
  }

  observeDevice(): void {}
  observeCapability(): void {}
  setTrustEpoch(): void {}
  observedIds(): string[] { return []; }
  observes(): boolean { return false; }
  controls(): boolean { return false; }
  hasCarStopEvidence(): boolean { return false; }
  missingCompanion(): 'none' { return 'none'; }
  project: DeviceAdapterSession['project'] = (snapshot) => snapshot;
  assertAllowed(): void {}
  controlEvents: DeviceAdapterSession['controlEvents'] = (_deviceId, capabilityId, value) => [{ capabilityId, value }];
}
