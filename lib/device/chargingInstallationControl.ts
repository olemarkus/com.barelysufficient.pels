import type { ChargingInstallation } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import type { ChargingInstallationMembership } from './deviceAdapter';
import type { DeviceAdapterSessions } from './deviceAdapterRegistry';
import type { DeviceControlSettings } from './deviceControlSettings';
import type { PowerSourceHome } from './transport/externalDevicePower';

type InstallationCurrentAccess = ChargingInstallation['role'] | 'blocked' | undefined;

/** Admission and current authority for a shared charging installation. */
export class ChargingInstallationControl {
  private readonly loggedInstallations = new Map<string, string>();

  constructor(
    private readonly sessions: Pick<DeviceAdapterSessions, 'chargingInstallationOf' | 'sharedChargingMemberIds'>,
    private readonly findDevice: (deviceId: string) => HomeyDeviceLike | undefined,
    private readonly resolveHome: PowerSourceHome,
    private readonly settings: Pick<DeviceControlSettings, 'isManaged' | 'isControllable'>,
    private readonly hasCurrentRoute: (device: HomeyDeviceLike) => boolean,
    private readonly logger: Pick<Logger, 'structuredLog'>,
  ) {}

  accessOf(device: HomeyDeviceLike): InstallationCurrentAccess {
    const membership = this.sessions.chargingInstallationOf(device);
    if (membership) return this.resolveAccess(device.id, membership);
    const shared = this.sessions.sharedChargingMemberIds(device);
    return shared && !this.sharesResolvedHome(device, shared) ? 'blocked' : undefined;
  }

  installationOf(device: HomeyDeviceLike): ChargingInstallation | undefined {
    const membership = this.sessions.chargingInstallationOf(device);
    if (!membership) return undefined;
    const role = this.resolveAccess(device.id, membership);
    if (!role || role === 'blocked') return undefined;
    return { id: membership.id, role, mainId: membership.mainId, memberIds: [...membership.memberIds] };
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
    // An already claimed channel on a mixed installation in one home keeps
    // its legacy behavior. Fully managed groups with no route use switches.
    if (!this.allMembersControlled(membership)) return undefined;
    if (!this.hasCurrentRoute(main)) return 'blocked';
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
    if (previous === key) return;
    this.loggedInstallations.set(id, key);
    const previousMainId = previous?.split('|')[1];
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
