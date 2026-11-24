import type { ChargingInstallation } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import type { ChargingInstallationMembership, InstallationCurrentAccess } from './deviceAdapter';
import type { DeviceAdapterSessions } from './deviceAdapterRegistry';
import type { DeviceControlSettings } from './deviceControlSettings';
import type { PowerSourceHome } from './transport/externalDevicePower';

export type InstallationCurrentRoute = 'shared' | 'flow' | 'per_charger' | 'refused' | 'unverified';

export function withholdsInstallationSteps(access: InstallationCurrentAccess): boolean {
  return access === 'secondary' || access === 'blocked';
}

/** Admission and current authority for a shared charging installation. */
export class ChargingInstallationControl {
  private readonly loggedInstallations = new Map<string, { key: string; mainId: string }>();

  constructor(
    private readonly sessions: Pick<DeviceAdapterSessions, 'chargingInstallationOf' | 'sharedChargingMemberIds'>,
    private readonly findDevice: (deviceId: string) => HomeyDeviceLike | undefined,
    private readonly resolveHome: PowerSourceHome,
    private readonly settings: Pick<DeviceControlSettings, 'isManaged' | 'isControllable'>,
    private readonly currentRoute: (
      main: HomeyDeviceLike | undefined, memberIds: readonly string[],
    ) => InstallationCurrentRoute,
    private readonly logger: Pick<Logger, 'structuredLog'>,
  ) {}

  accessOf(device: HomeyDeviceLike): InstallationCurrentAccess {
    return this.resolveDeviceAccess(device, this.sessions.chargingInstallationOf(device));
  }

  private resolveDeviceAccess(
    device: HomeyDeviceLike, membership: ChargingInstallationMembership | undefined,
  ): InstallationCurrentAccess {
    if (membership) return this.resolveAccess(device.id, membership);
    const shared = this.sessions.sharedChargingMemberIds(device);
    if (!shared) return undefined;
    return this.resolveSharedAccess(device, shared);
  }

  private resolveSharedAccess(device: HomeyDeviceLike, memberIds: readonly string[]): InstallationCurrentAccess {
    if (!this.sharesResolvedHome(device, memberIds)) return 'blocked';
    const route = this.currentRoute(undefined, memberIds);
    if (route === 'unverified') return 'blocked';
    return route === 'flow' ? 'per_charger' : undefined;
  }

  installationOf(device: HomeyDeviceLike): ChargingInstallation | undefined {
    return this.project(device).installation;
  }

  project(device: HomeyDeviceLike): {
    access: InstallationCurrentAccess;
    installation: ChargingInstallation | undefined;
  } {
    const membership = this.sessions.chargingInstallationOf(device);
    const access = this.resolveDeviceAccess(device, membership);
    const installation = membership && (access === 'main' || access === 'secondary')
      ? { id: membership.id, mainId: membership.mainId, memberIds: [...membership.memberIds] }
      : undefined;
    return { access, installation };
  }

  /** Setup can offer a current route before it has been enabled. */
  eligibleMainOf(device: HomeyDeviceLike): HomeyDeviceLike | undefined {
    const membership = this.sessions.chargingInstallationOf(device);
    if (!membership || !this.allMembersControlled(membership)) return undefined;
    return this.mainInSharedHome(membership);
  }

  private resolveAccess(deviceId: string, membership: ChargingInstallationMembership): InstallationCurrentAccess {
    const main = this.mainInSharedHome(membership);
    if (!main) return 'blocked';
    // A Flow on any member owns the current for the entire installation.
    const allControlled = this.allMembersControlled(membership);
    const route = this.currentRoute(allControlled ? main : undefined, membership.memberIds);
    if (route === 'refused' || route === 'unverified') return 'blocked';
    if (route === 'flow') return 'per_charger';
    if (!allControlled) return undefined;
    if (route === 'per_charger') return route;
    return membership.mainId === deviceId ? 'main' : 'secondary';
  }

  private allMembersControlled(membership: ChargingInstallationMembership): boolean {
    return membership.memberIds.every((id) => this.settings.isManaged(id) && this.settings.isControllable(id));
  }

  private mainInSharedHome(membership: ChargingInstallationMembership): HomeyDeviceLike | undefined {
    const main = this.findDevice(membership.mainId);
    return main && this.sharesResolvedHome(main, membership.memberIds) ? main : undefined;
  }

  private sharesResolvedHome(device: HomeyDeviceLike, memberIds: readonly string[]): boolean {
    const home = this.resolveHome(device.id, device.zone);
    return home !== undefined && memberIds.every((id) => {
      if (id === device.id) return true;
      const member = this.findDevice(id);
      return member !== undefined && this.resolveHome(id, member.zone) === home;
    });
  }

  /** Log again when the members, primary or control change. */
  logChanges(devices: readonly HomeyDeviceLike[]): void {
    const seen = new Map<string, ChargingInstallationMembership>();
    for (const device of devices) {
      const membership = this.sessions.chargingInstallationOf(device);
      if (membership) seen.set(membership.id, membership);
    }
    for (const [id, membership] of seen) this.logInstallation(id, membership);
    for (const id of this.loggedInstallations.keys()) if (!seen.has(id)) this.loggedInstallations.delete(id);
  }

  private logInstallation(id: string, membership: ChargingInstallationMembership): void {
    const { mainId, memberIds } = membership;
    const control = this.resolveAccess(mainId, membership) === 'main' ? 'one_load' : 'per_charger';
    const key = `${control}|${mainId}|${memberIds.join(',')}`;
    const previous = this.loggedInstallations.get(id);
    if (previous?.key === key) return;
    this.loggedInstallations.set(id, { key, mainId });
    const previousMainId = previous?.mainId;
    if (previousMainId !== undefined && previousMainId !== mainId) {
      this.logger.structuredLog.info({
        event: 'charging_installation_main_changed', installationId: id, previousMainId, mainId, memberIds,
      });
    }
    this.logger.structuredLog.info({
      event: 'charging_installation_resolved', installationId: id, control, mainId, memberIds,
      unmanagedIds: memberIds.filter((id) => !this.settings.isManaged(id)),
      notLimitedIds: memberIds.filter((id) => !this.settings.isControllable(id)),
    });
  }
}
