import type { DeviceAdapterSession } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';

/** The installation a Zaptec charger is on, by the id the app gives it. */
export const zaptecInstallationOf = (device: HomeyDeviceLike): string | undefined => (
  device.driverId?.startsWith('homey:app:com.zaptec:') === true ? device.data?.installationId || undefined : undefined
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
    return installationId !== undefined && this.sharedInstallations.has(installationId)
      ? ['target_power', 'target_power_mode'] : [];
  }

  observeDevice(): void {}
  observeCapability(): void {}
  setTrustEpoch(): void {}
  observedIds(): string[] { return []; }
  observes(): boolean { return false; }
  controls(): boolean { return false; }
  hasCarStopEvidence(): boolean { return false; }
  project: DeviceAdapterSession['project'] = (snapshot) => snapshot;
  assertAllowed(): void {}
  controlEvents: DeviceAdapterSession['controlEvents'] = (_deviceId, capabilityId, value) => [{ capabilityId, value }];
}
