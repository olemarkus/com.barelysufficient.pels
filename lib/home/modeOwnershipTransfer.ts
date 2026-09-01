import type { Logger as PinoLogger } from '../logging/logger';
import { MAIN_HOME_ID, type HomeId } from '../utils/settingsKeys';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { HomeMembershipPort } from './membership';

/** One device changing owning home, as the transfer resolves it. */
export type ModeOwnershipMove = {
  deviceId: string;
  fromHomeId: HomeId;
  toHomeId: HomeId;
};

/** Which moves the caller managed to carry, and which it must be asked again for. */
export type ModeOwnershipTransferResult = {
  completedDeviceIds: string[];
  failedDeviceIds: string[];
};

/**
 * The persisted last-committed owner per device, classified. `unwritten` is the
 * genuine never-written key — the one state a first write may be built on;
 * `suspect` is anything the adapter could not vouch for, and defers the pass.
 */
export type ModeTargetOwnershipRead =
  | { state: 'unwritten' }
  | { state: 'present'; owners: Record<string, HomeId> }
  | { state: 'suspect' };

/** The store port. `setup/homeRuntime/homeModeOwnershipStore.ts` implements it on `homey.settings`. */
export type ModeTargetOwnershipStore = {
  read: () => ModeTargetOwnershipRead;
  write: (owners: ReadonlyMap<string, HomeId>) => boolean;
};

export type ModeOwnershipTransferDeps = {
  store: ModeTargetOwnershipStore;
  getLogger: () => PinoLogger | undefined;
  /** Absent until membership is wired; the reconcile is a no-op until then. */
  getMembership: () => HomeMembershipPort | undefined;
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
  /**
   * Carry each device's persisted temperature anchor to its destination home.
   * Injected because the catalog that does it reads app-shaped state this
   * module may not name — `lib/home` is a declared pure leaf.
   */
  transferModeTargets: (moves: readonly ModeOwnershipMove[]) => ModeOwnershipTransferResult;
};

/**
 * Remembers the last committed owner of each target device so a membership
 * change can carry its persisted temperature anchor to the destination before
 * either home's plan rebuilds.
 *
 * Lives in `lib/home` because the memory is a membership fact. It used to take
 * the whole `AppContext`, which is what pinned it to the wiring layer:
 * `no-domain-to-app-layer` forbids a domain module from naming that type.
 */
export class ModeOwnershipTransfer {
  private readonly previousByDeviceId = new Map<string, HomeId>();

  private loaded = false;

  constructor(private readonly deps: ModeOwnershipTransferDeps) {}

  reconcile(allowPendingOwnershipGeneration = false): boolean {
    if (!this.hasAuthoritativeOwnership(allowPendingOwnershipGeneration)) return true;
    const current = this.readCurrentOwners();
    if (!this.ensureLoaded(current)) return false;
    const { moves, discoveries } = this.classifyChanges(current);
    const result = this.deps.transferModeTargets(moves);
    const persisted = this.persistCompletedChanges(current, discoveries, result.completedDeviceIds);
    if (result.failedDeviceIds.length > 0) {
      this.deps.getLogger()?.warn({
        event: 'home_mode_target_transfer_deferred',
        deviceIds: result.failedDeviceIds,
      });
      return false;
    }
    return persisted;
  }

  private hasAuthoritativeOwnership(allowPendingOwnershipGeneration: boolean): boolean {
    const membership = this.deps.getMembership();
    return membership !== undefined
      && membership.isOwnershipReady?.() === true
      && (
        allowPendingOwnershipGeneration
        || membership.hasPendingOwnershipGeneration?.() === false
      );
  }

  private readCurrentOwners(): Map<string, HomeId> {
    const membership = this.deps.getMembership();
    return new Map(
      this.deps.getLatestTargetSnapshot()
        .filter(isTemperatureControlDevice)
        .map((device) => [
          device.id,
          membership?.getHomeIdForDevice(device.id) ?? MAIN_HOME_ID,
        ]),
    );
  }

  private ensureLoaded(current: ReadonlyMap<string, HomeId>): boolean {
    if (this.loaded) return true;
    const persisted = this.deps.store.read();
    if (persisted.state === 'suspect') {
      this.warnUnavailable('read');
      return false;
    }
    if (persisted.state === 'present') {
      Object.entries(persisted.owners)
        .forEach(([deviceId, homeId]) => this.previousByDeviceId.set(deviceId, homeId));
    } else {
      if (!this.deps.store.write(current)) {
        this.warnUnavailable('write');
        return false;
      }
      current.forEach((homeId, deviceId) => this.previousByDeviceId.set(deviceId, homeId));
    }
    this.loaded = true;
    return true;
  }

  private classifyChanges(current: ReadonlyMap<string, HomeId>): {
    moves: ModeOwnershipMove[];
    discoveries: Array<[string, HomeId]>;
  } {
    const moves: ModeOwnershipMove[] = [];
    const discoveries: Array<[string, HomeId]> = [];
    current.forEach((toHomeId, deviceId) => {
      const fromHomeId = this.previousByDeviceId.get(deviceId);
      if (!fromHomeId) {
        discoveries.push([deviceId, toHomeId]);
        return;
      }
      if (fromHomeId !== toHomeId) {
        moves.push({ deviceId, fromHomeId, toHomeId });
      }
    });
    return { moves, discoveries };
  }

  private persistCompletedChanges(
    current: ReadonlyMap<string, HomeId>,
    discoveries: readonly [string, HomeId][],
    completedDeviceIds: readonly string[],
  ): boolean {
    if (discoveries.length === 0 && completedDeviceIds.length === 0) return true;
    const candidate = new Map(this.previousByDeviceId);
    discoveries.forEach(([deviceId, homeId]) => candidate.set(deviceId, homeId));
    completedDeviceIds.forEach((deviceId) => {
      const homeId = current.get(deviceId);
      if (homeId) candidate.set(deviceId, homeId);
    });
    if (!this.deps.store.write(candidate)) {
      this.warnUnavailable('write');
      return false;
    }
    this.previousByDeviceId.clear();
    candidate.forEach((homeId, deviceId) => this.previousByDeviceId.set(deviceId, homeId));
    return true;
  }

  private warnUnavailable(operation: 'read' | 'write'): void {
    this.deps.getLogger()?.warn({
      event: 'home_mode_target_ownership_store_unavailable',
      operation,
    });
  }
}
