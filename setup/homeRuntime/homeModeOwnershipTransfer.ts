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

/**
 * Remembers the last committed owner of each target device so a membership
 * change can carry its persisted temperature anchor to the destination before
 * either home's plan rebuilds.
 */
export class HomeModeOwnershipTransfer {
  private readonly previousByDeviceId = new Map<string, HomeId>();

  constructor(private readonly ctx: AppContext) {}

  reconcile(): boolean {
    const current = new Map(
      this.ctx.latestTargetSnapshot
        .filter(isTemperatureControlDevice)
        .map((device) => [
          device.id,
          this.ctx.homeMembership?.getHomeIdForDevice(device.id) ?? MAIN_HOME_ID,
        ]),
    );
    if (this.previousByDeviceId.size === 0) {
      current.forEach((homeId, deviceId) => this.previousByDeviceId.set(deviceId, homeId));
      return true;
    }
    const moves: ModeOwnershipMove[] = [];
    current.forEach((toHomeId, deviceId) => {
      const fromHomeId = this.previousByDeviceId.get(deviceId);
      if (fromHomeId && fromHomeId !== toHomeId) {
        moves.push({ deviceId, fromHomeId, toHomeId });
      }
    });
    const result = transferModeTargetsForOwnershipMoves(this.ctx, moves);
    result.completedDeviceIds.forEach((deviceId) => {
      const homeId = current.get(deviceId);
      if (homeId) this.previousByDeviceId.set(deviceId, homeId);
    });
    if (result.failedDeviceIds.length > 0) {
      this.ctx.getStructuredLogger('homes')?.warn({
        event: 'home_mode_target_transfer_deferred',
        deviceIds: result.failedDeviceIds,
      });
      return false;
    }
    for (const deviceId of [...this.previousByDeviceId.keys()]) {
      if (!current.has(deviceId)) this.previousByDeviceId.delete(deviceId);
    }
    return true;
  }
}
