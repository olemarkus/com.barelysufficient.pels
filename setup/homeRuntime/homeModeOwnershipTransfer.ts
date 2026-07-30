import type { AppContext } from '../../lib/app/appContext';
import {
  MAIN_HOME_ID,
  type HomeId,
} from '../../lib/utils/settingsKeys';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import {
  transferModeTargetsForOwnershipMoves,
  type ModeOwnershipMove,
} from './homeModeCatalog';
import { HomeModeOwnershipStore } from './homeModeOwnershipStore';

/**
 * Remembers the last committed owner of each target device so a membership
 * change can carry its persisted temperature anchor to the destination before
 * either home's plan rebuilds.
 */
export class HomeModeOwnershipTransfer {
  private readonly previousByDeviceId = new Map<string, HomeId>();
  private readonly store: HomeModeOwnershipStore;
  private loaded = false;

  constructor(private readonly ctx: AppContext) {
    this.store = new HomeModeOwnershipStore(ctx.homey.settings);
  }

  reconcile(allowPendingOwnershipGeneration = false): boolean {
    if (!this.hasAuthoritativeOwnership(allowPendingOwnershipGeneration)) return true;
    const current = this.readCurrentOwners();
    if (!this.ensureLoaded(current)) return false;
    const { moves, discoveries } = this.classifyChanges(current);
    const result = transferModeTargetsForOwnershipMoves(
      this.ctx,
      moves,
    );
    const persisted = this.persistCompletedChanges({
      current,
      discoveries,
      completedDeviceIds: result.completedDeviceIds,
    });
    if (result.failedDeviceIds.length > 0) {
      this.ctx.getStructuredLogger('homes')?.warn({
        event: 'home_mode_target_transfer_deferred',
        deviceIds: result.failedDeviceIds,
      });
      return false;
    }
    return persisted;
  }

  private hasAuthoritativeOwnership(allowPendingOwnershipGeneration: boolean): boolean {
    const membership = this.ctx.homeMembership;
    return membership !== undefined
      && membership.isOwnershipReady?.() === true
      && (
        allowPendingOwnershipGeneration
        || membership.hasPendingOwnershipGeneration?.() === false
      );
  }

  private readCurrentOwners(): Map<string, HomeId> {
    return new Map(
      this.ctx.latestTargetSnapshot
        .filter(isTemperatureControlDevice)
        .map((device) => [
          device.id,
          this.ctx.homeMembership?.getHomeIdForDevice(device.id) ?? MAIN_HOME_ID,
        ]),
    );
  }

  private ensureLoaded(current: ReadonlyMap<string, HomeId>): boolean {
    if (this.loaded) return true;
    const persisted = this.store.read();
    if (persisted.state === 'suspect') {
      this.warnUnavailable('read');
      return false;
    }
    if (persisted.state === 'present') {
      Object.entries(persisted.owners)
        .forEach(([deviceId, homeId]) => this.previousByDeviceId.set(deviceId, homeId));
    } else {
      if (!this.store.write(current)) {
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

  private persistCompletedChanges(params: {
    current: ReadonlyMap<string, HomeId>,
    discoveries: readonly [string, HomeId][],
    completedDeviceIds: readonly string[],
  }): boolean {
    const { current, discoveries, completedDeviceIds } = params;
    if (discoveries.length === 0 && completedDeviceIds.length === 0) return true;
    const candidate = new Map(this.previousByDeviceId);
    discoveries.forEach(([deviceId, homeId]) => candidate.set(deviceId, homeId));
    completedDeviceIds.forEach((deviceId) => {
      const homeId = current.get(deviceId);
      if (homeId) candidate.set(deviceId, homeId);
    });
    if (!this.store.write(candidate)) {
      this.warnUnavailable('write');
      return false;
    }
    this.previousByDeviceId.clear();
    candidate.forEach((homeId, deviceId) => this.previousByDeviceId.set(deviceId, homeId));
    return true;
  }

  private warnUnavailable(operation: 'read' | 'write'): void {
    this.ctx.getStructuredLogger('homes')?.warn({
      event: 'home_mode_target_ownership_store_unavailable',
      operation,
    });
  }
}
